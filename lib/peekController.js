// Centered peek: clone-based "browse" mode, real-window "commit" mode.
// Never calls activate / unminimize / focus. Zero MRU side effects.
//
// Two placement modes for the container:
//   • uiGroup (default) — below: <sibling> or on top of uiGroup.
//   • parent=<actor>, index=<n> — inside a specified widget's actor tree,
//     sized to that parent. Used by the window selector so the clone
//     sits behind its rows/band, above a solid tint.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Motion from './motion.js';
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

// mutter#836: animate first child rather than WindowActor.opacity.
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
        // Not added to chrome here — _attach decides based on first start().

        this._clone = null;
        this._currentWindow = null;
        this._mode = 'none';       // 'none' | 'clone' | 'real'
        this._hideTimer = 0;
        this._realState = null;
    }

    // ---- public API ----

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
        if (this._mode !== 'clone' || !this._currentWindow) return;
        const win = this._currentWindow;

        try {
            const cur = global.workspace_manager.get_active_workspace();
            if (win.get_workspace() !== cur) {
                journal('[peek] cross-workspace target — staying clone');
                return;
            }
        } catch (e) { return; }

        const wa = win.get_compositor_private();
        if (!wa) return;

        this._teardownClone();
        this._enterReal(win, wa);
        this._mode = 'real';
    }

    stop(immediate = false) {
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

    destroy() {
        if (this._hideTimer) { GLib.Source.remove(this._hideTimer); this._hideTimer = 0; }
        this._teardown();
        this._detach();
        if (this._container) {
            try { Main.layoutManager.removeChrome(this._container); } catch (e) { /* not tracked */ }
            try { this._container.destroy(); } catch (e) { /* gone */ }
            this._container = null;
        }
    }

    // ---- placement ----

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
                if (below && below.get_parent() === uiGroup)
                    uiGroup.set_child_below_sibling(c, below);
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
        // Leave chrome-managed container alone; only detach from custom parents.
        if (!currentParent || currentParent === uiGroup) return;
        try { currentParent.remove_child(c); } catch (e) { /* gone */ }
    }

    // ---- clone mode ----

    _showClone(win) {
        const built = this._buildClone(win);
        if (!built) return;

        const old = this._clone;
        this._clone = null;
        const install = () => this._installClone(built);

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

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return null;

        let rect;
        try { rect = win.get_frame_rect(); } catch (e) { return null; }
        const w = Math.max(1, rect.width);
        const h = Math.max(1, rect.height);

        const maxW = monitor.width * PREVIEW_FRACTION;
        const maxH = monitor.height * PREVIEW_FRACTION;
        let pw = w, ph = h;
        if (pw > maxW) { pw = maxW; ph = (h / w) * pw; }
        if (ph > maxH) { ph = maxH; pw = (w / h) * ph; }

        showActorForPreview(wa);

        const clone = new Clutter.Clone({ source: wa, reactive: false });
        clone.set_size(pw, ph);

        const bin = new St.Bin({
            child: clone,
            style: 'border-radius: 14px; overflow: hidden;',
        });
        bin._peekWin = win;
        bin._peekW = pw;
        bin._peekH = ph;
        bin._peekX = Math.round((monitor.width - pw) / 2);
        bin._peekY = Math.round((monitor.height - ph) / 2);
        return bin;
    }

    _installClone(bin) {
        if (bin._peekWin !== this._currentWindow) {
            try { bin.destroy(); } catch (e) { /* gone */ }
            return;
        }
        if (!this._container) return;

        // Note: container position/size is owned by _attach.
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
    }

    // ---- real mode ----

    _enterReal(win, wa) {
        const parent = wa.get_parent();
        if (!parent) return;

        showActorForPreview(wa);

        const priorIndex = parent.get_children().indexOf(wa);
        try { parent.set_child_above_sibling(wa, null); } catch (e) { return; }

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

        this._realState = { win, actor: wa, parent, priorIndex, dimTargets };
    }

    _teardownReal() {
        const s = this._realState;
        this._realState = null;
        if (!s) return;

        for (const other of s.dimTargets) fadeActor(other, 255, Motion.dur('fadeIn'));

        try {
            if (s.actor?.get_parent() === s.parent && s.priorIndex >= 0) {
                const len = s.parent.get_children().length;
                s.parent.set_child_at_index(s.actor, Math.min(s.priorIndex, len - 1));
            }
        } catch (e) { /* parent gone */ }

        restoreActorVisibility(s.actor);
    }

    // ---- common ----

    _teardown() {
        const win = this._currentWindow;
        if (this._mode === 'real') this._teardownReal();
        else if (this._mode === 'clone') this._teardownClone();
        this._mode = 'none';
        this._currentWindow = null;
        if (win) restoreActorVisibility(win.get_compositor_private());
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