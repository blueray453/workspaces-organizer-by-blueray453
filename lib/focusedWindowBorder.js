// ===== FILE: ./lib/focusedWindowBorder.js =====
// Border around the focused window. Eligibility: Model.focusedWindow().
// A suppressor can veto it (selected windows keep their own border).
import GLib from 'gi://GLib';
import * as Model from './model.js';
import { WindowBorder } from './windowBorder.js';

const border = new WindowBorder('focused-border');
let _suppressFn = () => false;
let _refreshId = 0;
let _ids = [];

function _draw(win) {
    if (!win || win.minimized || _suppressFn(win)) { border.hide(); return; }
    border.show(win);
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

export function setFocusBorderSuppressor(fn) { _suppressFn = fn ?? (() => false); _refresh(); }
export function refreshFocusedWindowBorder() { _refresh(); }

export function initFocusedWindowBorder() {
    const d = global.display, wm = global.window_manager;
    const onWm = (_wm, actor) => { if (actor === border.actor) _scheduleRefresh(); };
    _ids = [
        [d, d.connect('notify::focus-window', _scheduleRefresh)],
        [wm, wm.connect('minimize', onWm)],
        [wm, wm.connect('unminimize', onWm)],
        [d, d.connect('restacked', () => { border.restack(); _scheduleRefresh(); })],
    ];
    _refresh();
}

export function destroyFocusedWindowBorder() {
    for (const [obj, id] of _ids) { try { obj.disconnect(id); } catch (e) { /* gone */ } }
    _ids = [];
    if (_refreshId) { GLib.Source.remove(_refreshId); _refreshId = 0; }
    border.destroy();
    _suppressFn = () => false;
}