import Meta from 'gi://Meta';

import * as SearchOverlays from './searchOverlays.js';
import * as Model from './model.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== OVERLAY SERVICE ====================
// The single place any search overlay is opened or closed.
//
// IMPORTANT: overlays ignore the model's display-mode flag (`direct`).
// They always list every window on the workspace (and every window at all,
// for "all windows"), so the 5+ threshold that governs the indicator strip
// has zero effect here.

let _settings = null;

// -------------------- Show / close --------------------
export function showWindowOverlay(windows, context = null, focusedWindow = null) {
    if (!_settings) {
        journal('[overlayService] showWindowOverlay before init — ignoring', true);
        return false;
    }
    SearchOverlays.SearchOverlayBase.closeCurrent();
    const overlay = new SearchOverlays.WindowSearchOverlay(windows, _settings, focusedWindow);
    overlay._overlayContext = context;
    return true;
}

export function showAllWindows() {
    // getModelWindows(null) returns EVERY window across all workspaces —
    // not filtered by the per-workspace `direct` display-mode flag.
    return showWindowOverlay(
        Model.getModelWindows(null),
        { type: 'all-windows' },
        Model.Display.focus_window);
}

export function showAllApps() {
    if (!_settings) {
        journal('[overlayService] showAllApps before init — ignoring', true);
        return false;
    }
    SearchOverlays.SearchOverlayBase.closeCurrent();
    new SearchOverlays.AppSearchOverlay(_settings);
    return true;
}

export function toggleAllApps() {
    if (SearchOverlays.SearchOverlayBase.current instanceof SearchOverlays.AppSearchOverlay) {
        SearchOverlays.SearchOverlayBase.closeCurrent();
        return false;
    }
    return showAllApps();
}

// Three-state cycle:
//   1. no overlay (or a non-matching overlay, e.g. a workspace-scoped
//      window selector) → show the all-windows overlay
//   2. all-windows overlay is up    → advance to the all-apps overlay
//   3. all-apps overlay is up       → close the overlay
export function cycleOverlays() {
    const current = SearchOverlays.SearchOverlayBase.current;

    // (2) All-windows overlay is running → switch to the app launcher.
    if (current instanceof SearchOverlays.WindowSearchOverlay &&
        current._overlayContext?.type === 'all-windows') {
        return showAllApps();
    }

    // (3) All-apps overlay is running → close it.
    if (current instanceof SearchOverlays.AppSearchOverlay) {
        SearchOverlays.SearchOverlayBase.closeCurrent();
        return false;
    }

    // (1) Nothing open (or a different overlay) → show all windows.
    return showAllWindows();
}

export function showWorkspaceWindows(workspaceIndex) {
    const workspace = Model.WorkspaceManager.get_workspace_by_index(workspaceIndex);
    if (!workspace)
        throw new Error(`Workspace ${workspaceIndex} not found`);

    // Full window list from the model — `direct` is irrelevant here.
    const windows = Model.buildModel().workspaces[workspaceIndex].windows;
    const focusedWindow = Model.Display.get_tab_list(Meta.TabList.NORMAL, workspace)[0] ?? null;

    workspace.activate(global.get_current_time());
    const opened = showWindowOverlay(windows, { type: 'workspace', workspaceIndex }, focusedWindow);
    journal(`[overlayService] showWorkspaceWindows ${workspaceIndex} (${windows.length} windows)`);
    return opened;
}

export function toggleWorkspaceWindows(workspaceIndex) {
    const current = SearchOverlays.SearchOverlayBase.current;
    if (current instanceof SearchOverlays.WindowSearchOverlay &&
        current._overlayContext?.type === 'workspace' &&
        current._overlayContext.workspaceIndex === workspaceIndex) {
        SearchOverlays.SearchOverlayBase.closeCurrent();
        return false;
    }
    return showWorkspaceWindows(workspaceIndex);
}

export function closeOverlay() { return SearchOverlays.SearchOverlayBase.closeCurrent(); }

// -------------------- Lifecycle --------------------
export function initOverlayService(settings) {
    _settings = settings;
}

export function destroyOverlayService() {
    closeOverlay();
    _settings = null;
}