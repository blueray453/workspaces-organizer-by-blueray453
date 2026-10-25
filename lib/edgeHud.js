import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Model from './model.js';
import * as Scheduling from './scheduling.js';
import * as UI from './ui.js';
import { GroupFlyout } from './flyout.js';
import { externalDrag } from './externalDrag.js';
import { getPeek } from './peekController.js';
import { Dwell, Poller, Misses } from './util.js';
import { base } from './sizes.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const EDGE_PX = 8;
const OPEN_DWELL_MS = 150;
const TICK_MS = 40;
const PREVIEW_MS = 150;
const MISS_LIMIT = 5;

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
        this._appIdx = -1;
        this._edgeSince = 0;

        this._appDwell = new Dwell(this._scope, PREVIEW_MS);
        this._winDwell = new Dwell(this._scope, PREVIEW_MS);

        this._peekTarget = null;
        this._promoted = false;

        this._poll = new Poller(this._scope, {
            interval: TICK_MS, name: 'edgeHud', tick: () => this._tick(),
        });
        this._missCount = new Misses(MISS_LIMIT, () => this._closeAll());

        this._unsub = externalDrag.onChanged(state => state ? this._start() : this._stop());
        if (externalDrag.active) this._start();
    }

    _start() {
        if (this._poll.running) return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon) return;
        this._ensureEdge(mon);
        this._edgeSince = 0;
        this._missCount.reset();
        this._poll.start();
    }

    _stop() {
        this._poll.stop();
        // Must run before _closeAll(), which calls getPeek().stop().
        getPeek().finishDrag();
        this._closeAll();
    }

    _closeAll() {
        this._cancelApp();
        this._cancelWin();
        this._sub.close(true);
        this._hud.close(true);
        this._appIdx = -1;
        this._edgeSince = 0;
        this._missCount.reset();
        this._peekTarget = null;
        this._promoted = false;
        getPeek().stop();
    }

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

    _width(mon) {
        const b = base();
        return Math.round(clamp(mon.width * 0.22, 13 * b, 22.5 * b));
    }

    _buildApps() {
        const byId = new Map();
        const seen = new Set();
        const focus = Model.Display.focus_window;

        for (const w of Model.getModelWindows(null)) {
            if (seen.has(w)) continue;
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

    _tick() {
        if (!externalDrag.active) return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon || this._hasRightNeighbor(mon)) return;

        const [x, y] = global.get_pointer();
        const top = mon.y + (Main.panel?.height ?? 0) + 4;
        const atEdge = x >= mon.x + mon.width - EDGE_PX
            && y >= top && y < mon.y + mon.height;

        const subIn = this._sub.isOpen && this._sub.contains(x, y);
        const hudIn = this._hud.isOpen && this._hud.contains(x, y);
        const insideHud = subIn || hudIn;

        // (b): leaving both containers during drag = intent to drop.
        if (this._hud.isOpen && !insideHud && this._peekTarget) {
            if (!this._promoted) {
                this._promoted = true;
                getPeek().promoteToReal();
            }
        } else if (insideHud && this._promoted) {
            // Re-entered; a new row hover will start a fresh clone.
            this._promoted = false;
        }

        if (!this._hud.isOpen) {
            if (!atEdge) { this._edgeSince = 0; return; }
            const now = GLib.get_monotonic_time() / 1000;
            if (!this._edgeSince) { this._edgeSince = now; return; }
            if (now - this._edgeSince >= OPEN_DWELL_MS) this._open(mon);
            return;
        }

        if (subIn) {
            this._hud.highlightIndex(this._appIdx);
            this._cancelApp();
            const hit = this._sub.pointerAt(x, y);
            this._trackWindow(hit?.item?.window ?? null);
            this._missCount.reset();
            return;
        }

        if (this._sub.isOpen) this._sub.pointerAt(x, y);
        this._cancelWin();

        if (hudIn) {
            const hit = this._hud.pointerAt(x, y);
            this._trackApp(hit ? hit.index : -1);
            this._missCount.reset();
            return;
        }

        if (atEdge) { this._missCount.reset(); return; }

        this._cancelApp();
        this._missCount.miss();
    }

    _open(mon) {
        this._apps = this._buildApps();
        if (!this._apps.length) return;

        const opened = this._hud.open({
            anchor: this._ensureEdge(mon),
            title: `APPS · ${this._apps.length}`,
            items: this._apps.map(a => a.item),
            onDrop: null,
            sticky: true,
            anchorKey: 'edge-hud',
            hoverActivate: false,
            side: 'left', sideGap: 0,
            width: this._width(mon),
        });
        if (!opened) return;

        this._edgeSince = 0;
        this._missCount.reset();
        this._appIdx = -1;
        this._peekTarget = null;
        this._promoted = false;
        journal(`[edgeHud] open apps=${this._apps.length}`);
    }

    _trackApp(idx) {
        if (idx < 0 || idx === this._appIdx) {
            this._appDwell.cancel();
            return;
        }
        this._appDwell.arm(idx, () => this._showApp(idx));
    }

    _showApp(idx) {
        const app = this._apps[idx];
        if (!app || !this._hud.isOpen) return;

        this._appIdx = idx;
        this._peekTarget = app.rep;
        this._promoted = false;
        getPeek().start(app.rep, {
            mode: 'clone',
            below: this._hud.actor,
        });

        this._sub.close(true);
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

    _cancelApp() { this._appDwell.cancel(); }

    _trackWindow(win) {
        if (!win) { this._winDwell.cancel(); return; }
        this._winDwell.arm(String(win.get_id()), () => {
            this._peekTarget = win;
            this._promoted = false;
            getPeek().start(win, {
                mode: 'clone',
                below: this._sub.actor,
            });
        });
    }

    _cancelWin() { this._winDwell.cancel(); }

    destroy() {
        this._unsub?.();
        this._unsub = null;
        this._poll.stop();
        this._closeAll();
        this._scope.dispose();
        this._sub.destroy();
        this._hud.destroy();
        this._removeEdge();
    }
}