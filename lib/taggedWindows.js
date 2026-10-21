// ===== FILE: ./lib/taggedWindows.js =====
// The "tagged" tag ported from the standalone FocusedWindowBorder
// extension (previously named "marked"). Semantics kept identical:
//   • tagged windows do NOT follow the active workspace (their border
//     hides when they are not on the current workspace),
//   • tagged windows are exempt from
//     closeOtherNotTaggedCurrentWorkspaceWmClass(),
//   • after a close-others sweep, all tags are cleared,
//   • a tagged window never shows the focused-window border —
//     only one border at a time.
//
// Window eligibility is decided by Model (focusedWindow / getModelWindows
// / isNormalWindow). This module never inspects window types itself.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Model from './model.js';

import { setFocusBorderSuppressor, refreshFocusedWindowBorder }
    from './focusedWindowBorder.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const Display = global.get_display();
const WindowManager = global.get_window_manager();
const WorkspaceManager = global.get_workspace_manager();

const BORDER_FADE_MS = 150;

const state = {
    windowData: new Map(),   // actor -> { win, tagged, border, signals }
    activeWorkspaceId: 0,
    minimizeId: 0,
    unminimizeId: 0,
    restackedId: 0,
};

// ==================== per-actor bookkeeping ====================
function _ensure(actor) {
    if (state.windowData.has(actor)) return state.windowData.get(actor);
    const win = actor.get_meta_window();
    if (!win) return null;

    const info = {
        win,
        tagged: false,
        border: null,
        signals: {
            position: win.connect('position-changed', () => _positionBorder(actor)),
            size: win.connect('size-changed', () => _positionBorder(actor)),
            maximizedH: win.connect('notify::maximized-horizontally', () => _positionBorder(actor)),
            maximizedV: win.connect('notify::maximized-vertically', () => _positionBorder(actor)),
            workspace: win.connect('workspace-changed', () => _refreshVisibility(actor)),
            unmanaging: win.connect('unmanaging', () => _onActorUnmanaging(actor)),
        },
    };
    state.windowData.set(actor, info);
    return info;
}

function _detach(actor) {
    const info = state.windowData.get(actor);
    if (!info) return;
    for (const id of Object.values(info.signals)) {
        if (!id) continue;
        try { info.win.disconnect(id); } catch (e) { /* gone */ }
    }
}

// ==================== border ====================
function _getBorder(actor) {
    const info = state.windowData.get(actor);
    if (!info) return null;
    if (!info.border) info.border = new St.Bin({
        style_class: 'tagged-border',
        opacity: 0, reactive: false,
    });
    return info.border;
}

function _positionBorder(actor) {
    const info = state.windowData.get(actor);
    if (!info || !info.border || !info.border.get_parent()) return;
    const rect = info.win.get_frame_rect();
    info.border.set_position(rect.x, rect.y);
    info.border.set_size(rect.width, rect.height);
    global.get_window_group().set_child_above_sibling(info.border, actor);
}

function _addBorder(actor) {
    const border = _getBorder(actor);
    if (!border) return;
    const info = state.windowData.get(actor);
    const parent = info?.win.get_compositor_private()?.get_parent();
    if (!parent) return;

    if (border.get_parent() !== parent) {
        if (border.get_parent()) border.get_parent().remove_child(border);
        border.remove_all_transitions();
        border.opacity = 0;
        parent.add_child(border);
        border.ease({
            opacity: 255, duration: BORDER_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }
    _positionBorder(actor);
}

function _removeBorder(actor) {
    const border = state.windowData.get(actor)?.border;
    if (!border?.get_parent()) return;
    border.remove_all_transitions();
    border.get_parent().remove_child(border);
    border.opacity = 0;
}

function _refreshVisibility(actor) {
    const info = state.windowData.get(actor);
    if (!info || !info.tagged) { _removeBorder(actor); return; }
    const win = info.win;
    if (win.minimized) { _removeBorder(actor); return; }
    if (win.get_workspace() !== WorkspaceManager.get_active_workspace()) {
        _removeBorder(actor);
        return;
    }
    _addBorder(actor);
}

// ==================== toggling ====================
function _toggle(actor) {
    if (!actor) return;
    const info = _ensure(actor);
    if (!info) return;
    info.tagged = !info.tagged;

    // One border at a time: hand control back to the focus-border module.
    // If this window is focused, it will drop its cyan border; if it just
    // lost its tag, it will redraw it.
    refreshFocusedWindowBorder();

    if (info.tagged) {
        _refreshVisibility(actor);
        actor.remove_all_transitions();
        actor.set_pivot_point(0.5, 0.5);
        actor.set_scale(0.96, 0.96);
        actor.ease({
            scale_x: 1, scale_y: 1,
            duration: 220, mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    } else {
        _removeBorder(actor);
        if (info.border) { info.border.destroy(); info.border = null; }
        actor.ease({
            scale_x: 1, scale_y: 1,
            duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }
}

function _isTagged(actor) { return !!state.windowData.get(actor)?.tagged; }

function _isWindowTagged(win) {
    if (!win) return false;
    const actor = win.get_compositor_private();
    if (!actor) return false;
    return _isTagged(actor);
}

// ==================== signal handlers ====================
function _onActorUnmanaging(actor) {
    _detach(actor);
    _removeBorder(actor);
    const info = state.windowData.get(actor);
    if (info?.border) { info.border.destroy(); info.border = null; }
    state.windowData.delete(actor);
}

function _onActiveWorkspaceChanged() {
    for (const actor of state.windowData.keys()) _refreshVisibility(actor);
}

function _onMinimize(wm, actor) { if (state.windowData.has(actor)) _refreshVisibility(actor); }
function _onUnminimize(wm, actor) { if (state.windowData.has(actor)) _refreshVisibility(actor); }
function _onRestacked() {
    for (const [actor, info] of state.windowData) {
        if (info.border?.get_parent())
            global.get_window_group().set_child_above_sibling(info.border, actor);
    }
}

// ==================== public API (DBus-backed) ====================
export function toggleTagFocusedWindow() {
    const win = Model.focusedWindow();
    if (!win || !Model.isNormalWindow(win)) return;
    _toggle(win.get_compositor_private());
}

export function closeOtherNotTaggedCurrentWorkspaceWmClass() {
    const focusWin = Model.focusedWindow();
    if (!focusWin) return;
    const wmClass = focusWin.get_wm_class();
    if (!wmClass) return;

    const workspace = WorkspaceManager.get_active_workspace();
    const victims = Model.getModelWindows(workspace).filter(w => {
        if (w === focusWin) return false;
        if (!Model.isNormalWindow(w)) return false;
        if (w.get_wm_class() !== wmClass) return false;
        if (w.is_on_all_workspaces()) return false;
        return true;
    });

    let closed = 0;
    for (const w of victims) {
        if (w.get_wm_class_instance() === 'file_progress') continue;
        if (_isWindowTagged(w)) continue;
        w.delete(0);
        closed++;
    }

    for (const actor of [...state.windowData.keys()])
        if (_isTagged(actor)) _toggle(actor);

    journal(`[taggedWindows] closed ${closed} untagged ws-class siblings`);
}

// ==================== lifecycle ====================
export function initTaggedWindows() {
    setFocusBorderSuppressor(_isWindowTagged);
    state.activeWorkspaceId = WorkspaceManager.connect('active-workspace-changed', _onActiveWorkspaceChanged);
    state.minimizeId = WindowManager.connect('minimize', _onMinimize);
    state.unminimizeId = WindowManager.connect('unminimize', _onUnminimize);
    state.restackedId = Display.connect('restacked', _onRestacked);
}

export function destroyTaggedWindows() {
    setFocusBorderSuppressor(null);
    if (state.activeWorkspaceId) { WorkspaceManager.disconnect(state.activeWorkspaceId); state.activeWorkspaceId = 0; }
    if (state.minimizeId) { WindowManager.disconnect(state.minimizeId); state.minimizeId = 0; }
    if (state.unminimizeId) { WindowManager.disconnect(state.unminimizeId); state.unminimizeId = 0; }
    if (state.restackedId) { Display.disconnect(state.restackedId); state.restackedId = 0; }

    for (const actor of [...state.windowData.keys()]) {
        _detach(actor);
        const info = state.windowData.get(actor);
        if (info?.border) { info.border.destroy(); info.border = null; }
    }
    state.windowData.clear();
}