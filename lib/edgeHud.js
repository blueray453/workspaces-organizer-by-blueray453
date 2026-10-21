// ===== FILE: ./lib/edgeHud.js =====
// Right-edge HUD for external drags (files from Nautilus, Firefox, ...).
//
//   edge dwell  -> HUD opens: all active apps, grouped across workspaces
//   hover app   -> app's window is focused, sub HUD lists its windows
//   hover window-> that window is focused
//   leave both  -> everything closes; the chosen window is ready to drop on
//
// Both lists are GroupFlyout instances. External drags never enter St's
// DND chain, so everything is driven by a pointer poll (like the
// indicator's external poll) via GroupFlyout.pointerAt().

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Model from './model.js';
import * as Scheduling from './scheduling.js';
import * as UI from './ui.js';
import * as WorkspaceActions from './workspaceActions.js';
import { GroupFlyout } from './flyout.js';
import { externalDrag } from './externalDrag.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const EDGE_PX = 8;
const OPEN_DWELL_MS = 150;
const TICK_MS = 40;
const PREVIEW_MS = 150;     // hover time before focusing / switching app
const MISS_LIMIT = 5;       // ticks outside everything before closing

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 'S'}`;

export class EdgeHud {
    constructor(settings) {
        this._settings = settings;
        this._scope = new Scheduling.Scope();
        this._hud = new GroupFlyout(settings);
        this._sub = new GroupFlyout(settings);

        this._edge = null;
        this._edgeKey = '';

        this._apps = [];
        this._appIdx = -1;          // app whose sub HUD is showing

        this._pollId = 0;
        this._edgeSince = 0;
        this._misses = 0;

        this._hoverApp = -1;
        this._appTimer = 0;
        this._winKey = null;
        this._winTimer = 0;

        this._focusRelease = null;

        this._unsub = externalDrag.onChanged(state => state ? this._start() : this._stop());
        if (externalDrag.active) this._start();
    }

    // ---------- lifecycle ----------
    _start() {
        if (this._pollId) return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon) return;
        this._ensureEdge(mon);      // created now so it is allocated by the time we open
        this._edgeSince = 0;
        this._misses = 0;
        this._pollId = this._scope.timeout(TICK_MS, () => {
            try { this._tick(); }
            catch (e) { journal(`[edgeHud] tick THREW: ${e.message}\n${e.stack}`); }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stop() {
        if (this._pollId) { this._scope.cancel(this._pollId); this._pollId = 0; }
        this._closeAll();
    }

    _closeAll() {
        this._cancelApp();
        this._cancelWin();
        this._sub.close(true);
        this._hud.close(true);
        this._appIdx = -1;
        this._edgeSince = 0;
        this._misses = 0;
        this._focusRelease?.();
        this._focusRelease = null;
    }

    // ---------- geometry ----------
    _hasRightNeighbor(mon) {
        return Main.layoutManager.monitors.some(o =>
            o !== mon
            && o.x >= mon.x + mon.width
            && o.y < mon.y + mon.height
            && o.y + o.height > mon.y);
    }

    _ensureEdge(mon) {
        const panelH = Main.panel?.height ?? 0;
        const key = `${mon.x},${mon.y},${mon.width},${mon.height},${panelH}`;
        if (this._edge && this._edgeKey === key) return this._edge;
        this._removeEdge();
        // Invisible 1px strip on the right edge: the HUD's anchor.
        this._edge = new St.Widget({
            reactive: false,
            x: mon.x + mon.width - 1, y: mon.y + panelH,
            width: 1, height: mon.height - panelH,
        });
        Main.layoutManager.addChrome(this._edge,
            { affectsInputRegion: false, trackFullscreen: false });
        this._edgeKey = key;
        return this._edge;
    }

    _removeEdge() {
        if (!this._edge) return;
        try { Main.layoutManager.removeChrome(this._edge); } catch (e) { /* gone */ }
        try { this._edge.destroy(); } catch (e) { /* gone */ }
        this._edge = null;
        this._edgeKey = '';
    }

    _width(mon) { return Math.round(clamp(mon.width * 0.22, 520, 900)); }

    // ---------- data ----------
    _buildApps() {
        const byId = new Map();
        const seen = new Set();
        const focus = Model.Display.focus_window;

        for (const w of Model.getModelWindows(null)) {
            if (seen.has(w)) continue;          // all-workspace windows repeat per workspace
            seen.add(w);
            const { id, name } = Model.appIdentity(w);
            let g = byId.get(id);
            if (!g) { g = { id, name, windows: [] }; byId.set(id, g); }
            g.windows.push(w);
        }

        return [...byId.values()].map(g => {
            const rep = g.windows.includes(focus) ? focus
                : (g.windows.find(w => !w.minimized) ?? g.windows[0]);
            const n = g.windows.length;
            return {
                ...g, rep,
                item: {
                    window: rep,
                    icon: UI.getWindowAppIcon(rep),
                    title: g.name,
                    sub: plural(n, 'WINDOW'),
                    badge: n > 1 ? `×${n}` : '',
                    color: UI.colorForApp(g.name),
                },
            };
        });
    }

    _windowItems(app) {
        return app.windows.map(w => ({
            window: w,
            icon: UI.getWindowAppIcon(w),
            title: w.get_title() || 'Untitled Window',
            sub: `WS ${(w.get_workspace()?.index() ?? 0) + 1}`,
            color: UI.colorForApp(app.name),
        }));
    }

    // ---------- poll ----------
    _tick() {
        if (!externalDrag.active) return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon || this._hasRightNeighbor(mon)) return;

        const [x, y] = global.get_pointer();
        const top = mon.y + (Main.panel?.height ?? 0) + 4;
        const atEdge = x >= mon.x + mon.width - EDGE_PX
            && y >= top && y < mon.y + mon.height;

        if (!this._hud.isOpen) {
            if (!atEdge) { this._edgeSince = 0; return; }
            const now = GLib.get_monotonic_time() / 1000;
            if (!this._edgeSince) { this._edgeSince = now; return; }
            if (now - this._edgeSince >= OPEN_DWELL_MS) this._open(mon);
            return;
        }

        const subIn = this._sub.isOpen && this._sub.contains(x, y);
        if (subIn) {
            // Keep the app row lit while the pointer is in the sub HUD.
            this._hud.highlightIndex(this._appIdx);
            this._cancelApp();
            const hit = this._sub.pointerAt(x, y);
            this._trackWindow(hit?.item?.window ?? null);
            this._misses = 0;
            return;
        }

        if (this._sub.isOpen) this._sub.pointerAt(x, y);   // clears hover / edge scroll
        this._cancelWin();

        if (this._hud.contains(x, y)) {
            const hit = this._hud.pointerAt(x, y);
            this._trackApp(hit ? hit.index : -1);
            this._misses = 0;
            return;
        }

        if (atEdge) { this._misses = 0; return; }

        this._cancelApp();
        if (++this._misses >= MISS_LIMIT) {
            journal('[edgeHud] pointer left -> close');
            this._closeAll();
        }
    }

    _open(mon) {
        this._apps = this._buildApps();
        if (!this._apps.length) return;

        const opened = this._hud.open({
            anchor: this._ensureEdge(mon),
            title: `APPS · ${this._apps.length}`,
            items: this._apps.map(a => a.item),
            onDrop: null,
            sticky: true,               // no watchdog: this class owns closing
            anchorKey: 'edge-hud',
            hoverActivate: false,
            side: 'left', sideGap: 0,
            width: this._width(mon),
        });
        if (!opened) return;            // anchor not allocated yet: retry next tick

        this._edgeSince = 0;
        this._misses = 0;
        this._appIdx = -1;
        this._hoverApp = -1;
        if (!this._focusRelease) this._focusRelease = Model.holdFocusHistory();
        journal(`[edgeHud] open apps=${this._apps.length}`);
    }

    // ---------- app rows ----------
    _trackApp(idx) {
        if (idx === this._hoverApp) return;
        this._hoverApp = idx;
        this._cancelAppTimer();
        if (idx < 0 || idx === this._appIdx) return;
        this._appTimer = this._scope.timeout(PREVIEW_MS, () => {
            this._appTimer = 0;
            this._showApp(idx);
            return GLib.SOURCE_REMOVE;
        });
    }

    _showApp(idx) {
        const app = this._apps[idx];
        if (!app || !this._hud.isOpen) return;

        this._appIdx = idx;
        WorkspaceActions.focusWindow(app.rep);

        this._sub.close(true);          // rebuild for the new app
        if (app.windows.length < 2) return;

        const mon = Main.layoutManager.primaryMonitor;
        this._sub.open({
            anchor: this._hud.actor,
            title: `${app.name.toUpperCase()} · ${plural(app.windows.length, 'WINDOW')}`,
            items: this._windowItems(app),
            onDrop: null,
            sticky: true,
            anchorKey: 'edge-hud-sub',
            hoverActivate: false,
            selectedWindow: app.rep,
            side: 'left', sideGap: 8,
            width: this._width(mon),
        });
    }

    _cancelAppTimer() {
        if (this._appTimer) { this._scope.cancel(this._appTimer); this._appTimer = 0; }
    }

    _cancelApp() {
        this._hoverApp = -1;
        this._cancelAppTimer();
    }

    // ---------- window rows ----------
    _trackWindow(win) {
        const key = win ? String(win.get_id()) : null;
        if (key === this._winKey) return;
        this._winKey = key;
        this._cancelWinTimer();
        if (!win) return;
        this._winTimer = this._scope.timeout(PREVIEW_MS, () => {
            this._winTimer = 0;
            WorkspaceActions.focusWindow(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelWinTimer() {
        if (this._winTimer) { this._scope.cancel(this._winTimer); this._winTimer = 0; }
    }

    _cancelWin() {
        this._winKey = null;
        this._cancelWinTimer();
    }

    destroy() {
        this._unsub?.();
        this._unsub = null;
        if (this._pollId) { this._scope.cancel(this._pollId); this._pollId = 0; }
        this._closeAll();
        this._scope.dispose();
        this._sub.destroy();
        this._hud.destroy();
        this._removeEdge();
    }
}
