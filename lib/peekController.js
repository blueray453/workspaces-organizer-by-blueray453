// ===== FILE: ./lib/peekController.js =====
//
// finishDrag now uses WorkspaceActions.navigateToWindowMru.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Motion from './motion.js';
import * as WorkspaceActions from './workspaceActions.js';
import { externalDrag } from './externalDrag.js';
import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const HIDE_DEBOUNCE_MS = 80;
const DIM_OPACITY = 40;
const PREVIEW_FRACTION = 0.90;

function showActorForPreview(wa) {
    if (!wa) return;
    try {
        if (wa._peekPriorVisible === undefined)
            wa._peekPriorVisible = wa.visible;
        if (!wa.visible) wa.show();
    } catch (e) { /* gone */ }
}

function restoreActorVisibility(wa) {
    if (!wa) return;
    try {
        if (wa._peekPriorVisible === false) wa.hide();
        delete wa._peekPriorVisible;
    } catch (e) { /* gone or frozen */ }
}

function fadeActor(wa, target, duration) {
    if (!wa) return;
    try {
        const node = wa.get_first_child?.() ?? wa;
        if (duration <= 0) { node.opacity = target; return; }
        node.ease({
            opacity: target,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    } catch (e) { /* gone */ }
}

class PeekController {
    constructor() {
        this._container = new St.Widget({
            reactive: false,
            clip_to_allocation: false,
            visible: false,
        });

        this._clone = null;
        this._cloneWin = null;
        this._currentWindow = null;
        this._mode = 'none';
        this._hideTimer = 0;
        this._realState = null;

        this._switchPending = null;
        this._dragOrigWs = null;
    }

    start(win, { mode = 'clone', below = null, parent = null, index = -1 } = {}) {
        if (!win) return;

        if (this._hideTimer) {
            GLib.Source.remove(this._hideTimer);
            this._hideTimer = 0;
        }

        if (this._mode === 'real') {
            this._teardownReal();
            this._mode = 'none';
        }

        if (this._mode === 'clone' && this._currentWindow === win && this._clone) {
            this._attach({ below, parent, index });
            return;
        }

        this._currentWindow = win;
        this._mode = 'clone';
        this._attach({ below, parent, index });
        this._showClone(win);
    }

    promoteToReal() {
        if (this._mode !== 'clone' || !this._currentWindow || this._switchPending) return;
        const win = this._currentWindow;

        let cur;
        try {
            cur = global.workspace_manager.get_active_workspace();
            if (win.located_on_workspace(cur)) { this._promoteNow(win, false); return; }
        } catch (e) { return; }

        this._switchThenPromote(win, cur);
    }

    _promoteNow(win, crossed) {
        if (this._mode !== 'clone' || this._currentWindow !== win) return;
        const wa = win.get_compositor_private();
        if (!wa) return;

        if (crossed) { try { delete wa._peekPriorVisible; } catch (e) { /* gone */ } }

        this._teardownClone();
        this._enterReal(win, wa);
        this._mode = 'real';
    }

    _switchThenPromote(win, cur) {
        const ws = win.get_workspace();
        if (!ws) return;

        const wm = global.workspace_manager;
        const pending = { sig: 0, timer: 0 };
        this._switchPending = pending;
        this._dragOrigWs ??= cur;

        const finish = () => {
            if (this._switchPending !== pending) return;
            this._cancelSwitch();
            if (!externalDrag.active) return;
            this._promoteNow(win, true);
        };

        pending.sig = wm.connect('workspace-switched', finish);
        pending.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            pending.timer = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });

        try { ws.activate(global.get_current_time()); }
        catch (e) { journal(`[peek] workspace switch failed: ${e.message}`); this._cancelSwitch(); }
    }

    _cancelSwitch() {
        const p = this._switchPending;
        this._switchPending = null;
        if (!p) return;
        if (p.sig) { try { global.workspace_manager.disconnect(p.sig); } catch (e) { /* gone */ } }
        if (p.timer) GLib.Source.remove(p.timer);
    }

    stop(immediate = false) {
        if (this._mode === 'real' && externalDrag.active && !immediate)
            return;

        if (this._hideTimer) { GLib.Source.remove(this._hideTimer); this._hideTimer = 0; }

        if (immediate) {
            this._teardown();
            this._detach();
            return;
        }
        if (this._mode === 'none') return;

        this._hideTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, HIDE_DEBOUNCE_MS, () => {
                this._hideTimer = 0;
                this._teardown();
                this._detach();
                return GLib.SOURCE_REMOVE;
            });
    }

    finishDrag() {
        const s = this._realState;
        let inside = false;

        if (this._mode === 'real' && s) {
            try {
                const [x, y] = global.get_pointer();
                const r = s.win.get_frame_rect();
                inside = x >= r.x && x <= r.x + r.width &&
                    y >= r.y && y <= r.y + r.height;
            } catch (e) { /* window gone */ }

            if (inside) {
                s.keepStack = true;
                const win = s.win;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    WorkspaceActions.navigateToWindowMru(win);
                    return GLib.SOURCE_REMOVE;
                });
            }
        }

        const back = this._dragOrigWs;
        this._dragOrigWs = null;
        this.stop(true);

        if (back && !inside) {
            try {
                if (global.workspace_manager.get_active_workspace() !== back)
                    back.activate(global.get_current_time());
            } catch (e) { /* workspace removed */ }
        }
    }

    destroy() {
        this._cancelSwitch();
        if (this._hideTimer) { GLib.Source.remove(this._hideTimer); this._hideTimer = 0; }
        this._teardown();
        this._detach();
        if (this._container) {
            try { Main.layoutManager.removeChrome(this._container); } catch (e) { /* not tracked */ }
            try { this._container.destroy(); } catch (e) { /* gone */ }
            this._container = null;
        }
    }

    _attach({ below = null, parent = null, index = -1 } = {}) {
        const c = this._container;
        if (!c) return;

        const uiGroup = Main.layoutManager.uiGroup;
        const desiredParent = parent ?? uiGroup;
        const currentParent = c.get_parent?.() ?? null;
        const changingParent = currentParent !== desiredParent;

        if (changingParent) {
            if (currentParent === uiGroup) {
                try { Main.layoutManager.removeChrome(c); } catch (e) { /* not tracked */ }
            } else if (currentParent) {
                try { currentParent.remove_child(c); } catch (e) { /* gone */ }
            }

            if (parent) {
                try { parent.add_child(c); } catch (e) { /* gone */ }
            } else {
                try {
                    Main.layoutManager.addChrome(c, {
                        affectsInputRegion: false,
                        trackFullscreen: false,
                    });
                } catch (e) { /* not ready */ }
            }
        }

        if (parent) {
            if (index >= 0) {
                try { parent.set_child_at_index(c, index); } catch (e) { /* gone */ }
            }
            const mon = Main.layoutManager.primaryMonitor;
            const pw = parent.width > 0 ? parent.width : (mon?.width ?? 0);
            const ph = parent.height > 0 ? parent.height : (mon?.height ?? 0);
            try {
                c.set_position(0, 0);
                c.set_size(pw, ph);
            } catch (e) { /* not allocated */ }
        } else {
            try {
                const panelBox = Main.layoutManager.panelBox;
                if (panelBox && panelBox.get_parent() === uiGroup)
                    uiGroup.set_child_below_sibling(c, panelBox);
                else
                    uiGroup.set_child_above_sibling(c, null);
            } catch (e) { /* uiGroup not ready */ }

            const mon = Main.layoutManager.primaryMonitor;
            if (mon) {
                try {
                    c.set_position(mon.x, mon.y);
                    c.set_size(mon.width, mon.height);
                } catch (e) { /* not ready */ }
            }
        }
    }

    _detach() {
        const c = this._container;
        if (!c) return;
        const uiGroup = Main.layoutManager.uiGroup;
        const currentParent = c.get_parent?.();
        if (!currentParent || currentParent === uiGroup) return;
        try { currentParent.remove_child(c); } catch (e) { /* gone */ }
    }

    _showClone(win) {
        const built = this._buildClone(win);
        if (!built) return;

        const prevWin = this._cloneWin;
        this._cloneWin = win;
        const releasePrev = () => {
            if (prevWin && prevWin !== win)
                restoreActorVisibility(prevWin.get_compositor_private());
        };

        const old = this._clone;
        this._clone = null;
        const install = () => { releasePrev(); this._installClone(built); };

        if (old && old.get_stage()) {
            Motion.fadeOut(old, {
                duration: 'fadeOut',
                onComplete: () => {
                    try { old.destroy(); } catch (e) { /* gone */ }
                    install();
                },
            });
        } else {
            install();
        }
    }

    _buildClone(win) {
        const wa = win.get_compositor_private();
        if (!wa) return null;

        const lm = Main.layoutManager;
        const monitor = lm.primaryMonitor;
        if (!monitor) return null;

        let frame, buffer;
        try { frame = win.get_frame_rect(); buffer = win.get_buffer_rect(); }
        catch (e) { return null; }
        const fw = Math.max(1, frame.width), fh = Math.max(1, frame.height);

        let x, y, pw, ph;
        const maximized = win.is_fullscreen()
            || (win.maximized_horizontally && win.maximized_vertically);

        if (maximized) {
            const area = win.is_fullscreen()
                ? monitor
                : lm.getWorkAreaForMonitor(lm.primaryIndex);
            x = area.x - monitor.x;
            y = area.y - monitor.y;
            pw = area.width;
            ph = area.height;
        } else {
            const maxW = monitor.width * PREVIEW_FRACTION;
            const maxH = monitor.height * PREVIEW_FRACTION;
            pw = fw; ph = fh;
            if (pw > maxW) { pw = maxW; ph = (fh / fw) * pw; }
            if (ph > maxH) { ph = maxH; pw = (fw / fh) * ph; }
            x = Math.round((monitor.width - pw) / 2);
            y = Math.round((monitor.height - ph) / 2);
        }

        showActorForPreview(wa);

        const sx = pw / fw, sy = ph / fh;
        const host = new St.Widget({ clip_to_allocation: true, reactive: false });
        host.set_size(pw, ph);

        const clone = new Clutter.Clone({ source: wa, reactive: false });
        clone.set_size(buffer.width * sx, buffer.height * sy);
        clone.set_position(Math.round((buffer.x - frame.x) * sx),
            Math.round((buffer.y - frame.y) * sy));
        host.add_child(clone);

        host._peekWin = win;
        host._peekW = pw;
        host._peekH = ph;
        host._peekX = Math.round(x);
        host._peekY = Math.round(y);
        return host;
    }

    _installClone(bin) {
        if (bin._peekWin !== this._currentWindow) {
            try { bin.destroy(); } catch (e) { /* gone */ }
            return;
        }
        if (!this._container) return;

        this._container.opacity = 255;
        this._container.show();

        this._container.destroy_all_children();
        this._container.add_child(bin);
        this._clone = bin;
        bin.set_size(bin._peekW, bin._peekH);
        bin.set_position(bin._peekX, bin._peekY);
        Motion.fadeIn(bin, { duration: 'fadeIn' });
    }

    _teardownClone() {
        const win = this._currentWindow;
        if (this._clone) {
            try { this._clone.destroy(); } catch (e) { /* gone */ }
            this._clone = null;
        }
        if (this._container) {
            this._container.remove_all_transitions();
            this._container.destroy_all_children();
            this._container.hide();
            this._container.opacity = 0;
        }
        if (win) restoreActorVisibility(win.get_compositor_private());
        this._cloneWin = null;
    }

    _enterReal(win, wa) {
        showActorForPreview(wa);

        let above = [];
        try {
            const all = global.get_window_actors()
                .map(a => a.get_meta_window?.()).filter(Boolean);
            const stack = global.display.sort_windows_by_stacking(all);
            above = stack.slice(stack.indexOf(win) + 1);
        } catch (e) { /* fall back to no restore list */ }

        try { win.raise(); } catch (e) { return; }

        const dimTargets = new Set();
        for (const other of global.get_window_actors()) {
            if (other === wa) continue;
            const mw = other.get_meta_window?.();
            if (!mw) continue;
            try {
                if (mw.get_window_type() !== Meta.WindowType.NORMAL) continue;
            } catch (e) { continue; }
            dimTargets.add(other);
            fadeActor(other, DIM_OPACITY, Motion.dur('fadeOut'));
        }

        this._realState = { win, actor: wa, above, dimTargets, keepStack: false };
    }

    _teardownReal() {
        const s = this._realState;
        this._realState = null;
        if (!s) return;

        for (const other of s.dimTargets) fadeActor(other, 255, Motion.dur('fadeIn'));

        if (!s.keepStack) {
            for (const w of s.above) { try { w.raise(); } catch (e) { /* gone */ } }
        }

        restoreActorVisibility(s.actor);
    }

    _teardown() {
        this._cancelSwitch();
        const win = this._currentWindow;
        if (this._mode === 'real') this._teardownReal();
        else if (this._mode === 'clone') this._teardownClone();
        this._mode = 'none';
        this._currentWindow = null;
        if (win) restoreActorVisibility(win.get_compositor_private());
        this._cloneWin = null;
    }
}

let _instance = null;
export function getPeek() {
    if (!_instance) _instance = new PeekController();
    return _instance;
}
export function destroyPeek() {
    _instance?.destroy();
    _instance = null;
}