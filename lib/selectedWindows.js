// ===== FILE: ./lib/selectedWindows.js =====
//
// _refreshVisibility uses showing_on_its_workspace + located_on_workspace.
// closeNotSelectedWindows uses Model.isFileProgress.

import * as Model from './model.js';
import * as Motion from './motion.js';
import { WindowBorder } from './windowBorder.js';
import { setFocusBorderSuppressor, refreshFocusedWindowBorder } from './focusedWindowBorder.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const Display = global.get_display();
const WindowManager = global.get_window_manager();
const WorkspaceManager = global.get_workspace_manager();

const state = {
    windowData: new Map(),
    activeWorkspaceId: 0,
    minimizeId: 0,
    unminimizeId: 0,
    restackedId: 0,
};

function _ensure(actor) {
    if (state.windowData.has(actor)) return state.windowData.get(actor);
    const win = actor.get_meta_window();
    if (!win) return null;

    const info = {
        win,
        selected: false,
        border: null,
        signals: {
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

function _addBorder(actor) {
    const info = state.windowData.get(actor);
    if (!info) return;
    info.border ??= new WindowBorder('selected-border', { fade: 'selectBorder' });
    info.border.show(info.win);
}

function _removeBorder(actor) {
    state.windowData.get(actor)?.border?.hide();
}

function _refreshVisibility(actor) {
    const info = state.windowData.get(actor);
    if (!info || !info.selected) { _removeBorder(actor); return; }
    const win = info.win;
    if (!win.showing_on_its_workspace()) { _removeBorder(actor); return; }
    if (!win.located_on_workspace(WorkspaceManager.get_active_workspace())) {
        _removeBorder(actor);
        return;
    }
    _addBorder(actor);
}

function _toggle(actor) {
    if (!actor) return;
    const info = _ensure(actor);
    if (!info) return;
    info.selected = !info.selected;

    refreshFocusedWindowBorder();

    if (info.selected) {
        _refreshVisibility(actor);
        Motion.pop(actor, { from: 0.96 });
    } else {
        _removeBorder(actor);
        info.border?.destroy();
        info.border = null;
        Motion.animate(actor, { scale_x: 1, scale_y: 1 }, { duration: 'selectPopOut' });
    }

    Model.requestRender();
}

function _isSelected(actor) { return !!state.windowData.get(actor)?.selected; }

function _onActorUnmanaging(actor) {
    _detach(actor);
    _removeBorder(actor);
    const info = state.windowData.get(actor);
    if (info?.border) { info.border.destroy(); info.border = null; }
    state.windowData.delete(actor);
    Model.requestRender();
}

function _onActiveWorkspaceChanged() {
    for (const actor of state.windowData.keys()) _refreshVisibility(actor);
}

function _onMinimize(wm, actor) { if (state.windowData.has(actor)) _refreshVisibility(actor); }
function _onUnminimize(wm, actor) { if (state.windowData.has(actor)) _refreshVisibility(actor); }
function _onRestacked() {
    for (const info of state.windowData.values()) info.border?.restack();
}

// ═══════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════

export function isWindowSelected(win) {
    if (!win) return false;
    const actor = win.get_compositor_private();
    if (!actor) return false;
    return _isSelected(actor);
}

export function hasAnySelected() {
    for (const info of state.windowData.values())
        if (info.selected) return true;
    return false;
}

export function selectedCount() {
    let n = 0;
    for (const info of state.windowData.values())
        if (info.selected) n++;
    return n;
}

export function toggleWindow(win) {
    if (!win) return;
    const actor = win.get_compositor_private();
    if (!actor) return;
    _toggle(actor);
}

export function toggleSelectedWindow() {
    const win = Model.focusedWindow();
    if (!win || !Model.isNormalWindow(win)) return;
    toggleWindow(win);
}

export function closeNotSelectedWindows() {
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
        if (Model.isFileProgress(w)) continue;
        if (isWindowSelected(w)) continue;
        w.delete(0);
        closed++;
    }

    for (const actor of [...state.windowData.keys()])
        if (_isSelected(actor)) _toggle(actor);

    journal(`[selectedWindows] closed ${closed} unselected ws-class siblings`);
}

export function initSelectedWindows() {
    setFocusBorderSuppressor(isWindowSelected);
    state.activeWorkspaceId = WorkspaceManager.connect('active-workspace-changed', _onActiveWorkspaceChanged);
    state.minimizeId = WindowManager.connect('minimize', _onMinimize);
    state.unminimizeId = WindowManager.connect('unminimize', _onUnminimize);
    state.restackedId = Display.connect('restacked', _onRestacked);
}

export function destroySelectedWindows() {
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