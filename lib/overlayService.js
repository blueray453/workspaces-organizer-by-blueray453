import Meta from 'gi://Meta';

import { SearchOverlayBase, WindowSearchOverlay, AppSearchOverlay } from './searchOverlays.js';
import { buildModel, getModelWindows, Display, WorkspaceManager } from './model.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== OVERLAY SERVICE ====================
// The single place any search overlay is opened or closed. Only one overlay
// exists at a time (each pushes a full-screen modal grab), so every show
// closes whatever was open first. WindowSearchOverlay serves both "all
// windows" and "one workspace", so instances are tagged with
// `_overlayContext` for toggles.
//
// Transport (DBus, keybindings, etc.) lives elsewhere. This module never
// talks to the bus.

let _settings = null;

// -------------------- Show / close --------------------
export function showWindowOverlay(windows, context = null, focusedWindow = null) {
    if (!_settings) {
        journal('[overlayService] showWindowOverlay before init — ignoring', true);
        return false;
    }
    SearchOverlayBase.closeCurrent();
    const overlay = new WindowSearchOverlay(windows, _settings, focusedWindow);
    overlay._overlayContext = context;
    return true;
}

export function showAllWindows() {
    return showWindowOverlay(
        getModelWindows(null),   // model order (user order)
        { type: 'all-windows' },
        Display.focus_window);
}

export function showAllApps() {
    if (!_settings) {
        journal('[overlayService] showAllApps before init — ignoring', true);
        return false;
    }
    SearchOverlayBase.closeCurrent();
    new AppSearchOverlay(_settings);
    return true;
}

export function toggleAllApps() {
    if (SearchOverlayBase.current instanceof AppSearchOverlay) {
        SearchOverlayBase.closeCurrent();
        return false;
    }
    return showAllApps();
}

export function toggleAllWindows() {
    const current = SearchOverlayBase.current;
    if (current instanceof WindowSearchOverlay && current._overlayContext?.type === 'all-windows') {
        SearchOverlayBase.closeCurrent();
        return false;
    }
    return showAllWindows();
}

// One workspace's windows, plus a workspace switch. Window list comes from
// the model (user order); "focused" comes from Mutter's own per-workspace
// MRU list, read BEFORE activating (workspace.activate() doesn't reliably
// refocus on its own).
export function showWorkspaceWindows(workspaceIndex) {
    const workspace = WorkspaceManager.get_workspace_by_index(workspaceIndex);
    if (!workspace)
        throw new Error(`Workspace ${workspaceIndex} not found`);

    const windows = buildModel().workspaces[workspaceIndex].windows;
    const focusedWindow = Display.get_tab_list(Meta.TabList.NORMAL, workspace)[0] ?? null;

    workspace.activate(global.get_current_time());
    const opened = showWindowOverlay(windows, { type: 'workspace', workspaceIndex }, focusedWindow);
    journal(`[overlayService] showWorkspaceWindows ${workspaceIndex} (${windows.length} windows)`);
    return opened;
}

export function toggleWorkspaceWindows(workspaceIndex) {
    const current = SearchOverlayBase.current;
    if (current instanceof WindowSearchOverlay &&
        current._overlayContext?.type === 'workspace' &&
        current._overlayContext.workspaceIndex === workspaceIndex) {
        SearchOverlayBase.closeCurrent();
        return false;
    }
    return showWorkspaceWindows(workspaceIndex);
}

export function closeOverlay() { return SearchOverlayBase.closeCurrent(); }

// -------------------- Lifecycle --------------------
export function initOverlayService(settings) {
    _settings = settings;
}

export function destroyOverlayService() {
    closeOverlay();    // never leave a modal grab behind
    _settings = null;
}