// ===== FILE: ./lib/focusedWindowBorder.js =====
// Paints a border around the currently focused window. The border is a
// plain St.Bin parented into the window group (same parent as the window
// actor), so it stacks with normal windows and is repositioned whenever
// the window moves, resizes, maximizes, is minimized, or the stacking
// order changes.
//
// Eligibility is decided by Model.focusedWindow() — the extension's
// single window-filter. This module never inspects window types.
//
// A suppressor predicate can veto the focus border for particular
// windows. The selected-windows module registers one so selected windows
// keep their own yellow outline even when focused — one border at a
// time, no cyan/yellow stacking race, no flicker.

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Model from './model.js';

const Display = global.get_display();
const WindowManager = global.get_window_manager();

const FOCUSED_BORDER_CLASS = 'focused-border';

let _border = null;
let _actor = null;
let _win = null;
let _winSignals = {};
let _refreshId = 0;

let _focusSignalId = 0;
let _minimizeSignalId = 0;
let _unminimizeSignalId = 0;
let _restackedSignalId = 0;

// A registered predicate that can veto the focus border for particular
// windows. The selected-windows module uses this so selected windows
// keep their own yellow outline even when focused.
let _suppressFn = () => false;

export function setFocusBorderSuppressor(fn) {
    _suppressFn = fn ?? (() => false);
    _refresh();
}

export function refreshFocusedWindowBorder() { _refresh(); }

function _position() {
    if (!_border || !_win || !_border.get_parent()) return;
    const rect = _win.get_frame_rect();
    _border.set_position(rect.x, rect.y);
    _border.set_size(rect.width, rect.height);
}

function _restack() {
    if (!_border || !_actor || !_border.get_parent()) return;
    global.get_window_group().set_child_above_sibling(_border, _actor);
}

function _onGeometryChanged() {
    _position();
    _restack();
}

function _detachWinSignals() {
    if (_win) {
        for (const id of Object.values(_winSignals)) {
            if (!id) continue;
            try { _win.disconnect(id); } catch (e) { /* gone */ }
        }
    }
    _winSignals = {};
}

function _remove() {
    _detachWinSignals();
    if (_border?.get_parent()) _border.get_parent().remove_child(_border);
    if (_border) { _border.destroy(); _border = null; }
    _actor = null;
    _win = null;
}

function _draw(win) {
    if (!win || win.minimized) { _remove(); return; }
    if (_suppressFn(win)) { _remove(); return; }

    const actor = win.get_compositor_private();
    if (!actor || !actor.get_parent()) { _remove(); return; }

    if (_win !== win || _actor !== actor) {
        _remove();
        _border = new St.Bin({ style_class: FOCUSED_BORDER_CLASS, reactive: false });
        _actor = actor;
        _win = win;
        actor.get_parent().add_child(_border);
        _winSignals = {
            position: win.connect('position-changed', _onGeometryChanged),
            size: win.connect('size-changed', _onGeometryChanged),
            maximizedH: win.connect('notify::maximized-horizontally', _onGeometryChanged),
            maximizedV: win.connect('notify::maximized-vertically', _onGeometryChanged),
        };
    }

    _position();
    _restack();
}

function _refresh() { _draw(Model.focusedWindow()); }

function _scheduleRefresh() {
    if (_refreshId) return;
    _refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        _refreshId = 0;
        _refresh();
        return GLib.SOURCE_REMOVE;
    });
}

function _onMinimize(wm, actor) { if (actor === _actor) _scheduleRefresh(); }
function _onUnminimize(wm, actor) { if (actor === _actor) _scheduleRefresh(); }
function _onRestacked() { _restack(); _scheduleRefresh(); }

export function initFocusedWindowBorder() {
    _focusSignalId = Display.connect('notify::focus-window', _scheduleRefresh);
    _minimizeSignalId = WindowManager.connect('minimize', _onMinimize);
    _unminimizeSignalId = WindowManager.connect('unminimize', _onUnminimize);
    _restackedSignalId = Display.connect('restacked', _onRestacked);
    _refresh();
}

export function destroyFocusedWindowBorder() {
    if (_focusSignalId) { Display.disconnect(_focusSignalId); _focusSignalId = 0; }
    if (_minimizeSignalId) { WindowManager.disconnect(_minimizeSignalId); _minimizeSignalId = 0; }
    if (_unminimizeSignalId) { WindowManager.disconnect(_unminimizeSignalId); _unminimizeSignalId = 0; }
    if (_restackedSignalId) { Display.disconnect(_restackedSignalId); _restackedSignalId = 0; }
    if (_refreshId) { GLib.Source.remove(_refreshId); _refreshId = 0; }
    _remove();
    _suppressFn = () => false;
}