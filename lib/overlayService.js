import Meta from 'gi://Meta';

import * as SearchOverlays from './searchOverlays.js';
import * as Model from './model.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== OVERLAY SERVICE ====================
// The single place any search overlay is opened or closed.
// Overlays ignore the model's display-mode flag (`direct`): they always
// list every window, so the 5+ regrouping threshold never leaks in here.

let _settings = null;

export function showWindowOverlay(windows, context = null, focusedWindow = null) {
    if (!_settings) {
        journal('[overlayService] showWindowOverlay before init — ignoring');
        return false;
    }
    SearchOverlays.SearchOverlayBase.closeCurrent();
    const overlay = new SearchOverlays.WindowSearchOverlay(windows, _settings, focusedWindow);
    overlay._overlayContext = context;
    return true;
}

export function showAllWindows() {
    return showWindowOverlay(
        Model.getModelWindows(null),
        { type: 'all-windows' },
        Model.Display.focus_window);
}

export function showAllApps() {
    if (!_settings) {
        journal('[overlayService] showAllApps before init — ignoring');
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

export function cycleOverlays() {
    const current = SearchOverlays.SearchOverlayBase.current;

    if (current instanceof SearchOverlays.WindowSearchOverlay &&
        current._overlayContext?.type === 'all-windows') {
        return showAllApps();
    }
    if (current instanceof SearchOverlays.AppSearchOverlay) {
        SearchOverlays.SearchOverlayBase.closeCurrent();
        return false;
    }
    return showAllWindows();
}

export function showWorkspaceWindows(workspaceIndex) {
    const workspace = Model.WorkspaceManager.get_workspace_by_index(workspaceIndex);
    if (!workspace) throw new Error(`Workspace ${workspaceIndex} not found`);

    const windows = Model.buildModel().workspaces[workspaceIndex].windows;
    const focusedWindow = Model.Display.get_tab_list(Meta.TabList.NORMAL, workspace)[0] ?? null;

    workspace.activate(global.get_current_time());
    return showWindowOverlay(windows, { type: 'workspace', workspaceIndex }, focusedWindow);
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

/**
 * Anchored on a badged app group in the indicator: the selector shows only
 * that workspace-local app group, but as a full list (not a flyout).
 */
export function showGroupWindows(workspaceIndex, appId) {
    const entry = Model.buildModel().workspaces[workspaceIndex];
    if (!entry) return false;

    const group = entry.groups.find(g => g.appId === appId);
    if (!group || !group.windows.length) return false;

    const focused = Model.Display.focus_window;
    const start = Math.max(0, group.windows.indexOf(focused));
    const opened = showWindowOverlay(
        group.windows,
        { type: 'group', workspaceIndex, appId, appName: group.appName },
        focused);
    journal(`[overlayService] showGroupWindows ws${workspaceIndex} ${group.appName} (${group.windows.length})`);
    return opened ? start >= 0 : false;
}

export function toggleGroupWindows(workspaceIndex, appId) {
    const current = SearchOverlays.SearchOverlayBase.current;
    if (current instanceof SearchOverlays.WindowSearchOverlay &&
        current._overlayContext?.type === 'group' &&
        current._overlayContext.workspaceIndex === workspaceIndex &&
        current._overlayContext.appId === appId) {
        SearchOverlays.SearchOverlayBase.closeCurrent();
        return false;
    }
    return showGroupWindows(workspaceIndex, appId);
}

export function closeOverlay() { return SearchOverlays.SearchOverlayBase.closeCurrent(); }

// -------------------- Lifecycle --------------------
export function initOverlayService(settings) { _settings = settings; }

export function destroyOverlayService() {
    closeOverlay();
    _settings = null;
}