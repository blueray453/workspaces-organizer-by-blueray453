import Meta from 'gi://Meta';

import { SearchOverlayBase } from './overlayBase.js';
import { WindowSearchOverlay } from './windowOverlay.js';
import { AppSearchOverlay } from './appOverlay.js';
import { GenericSearchOverlay } from './genericOverlay.js';
import * as Model from './model.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

let _settings = null;

export function showWindowOverlay(windows, context = null, focusedWindow = null, initialFilters = null) {
    if (!_settings) return false;
    SearchOverlayBase.closeCurrent();
    const overlay = new WindowSearchOverlay(windows, _settings, focusedWindow, initialFilters);
    overlay._overlayContext = context;
    return true;
}

export function showAllWindows(initialFilters = null) {
    if (!_settings) return false;
    const activeIdx = Model.WorkspaceManager.get_active_workspace_index();
    const activeWs = Model.WorkspaceManager.get_workspace_by_index(activeIdx);
    const focusedWindow =
        Model.Display.get_tab_current(Meta.TabList.NORMAL_ALL, activeWs)
        ?? Model.Display.focus_window
        ?? null;
    return showWindowOverlay(
        Model.getModelWindows(null),
        { type: 'all-windows' },
        focusedWindow,
        initialFilters);
}

export function showAllApps() {
    if (!_settings) return false;
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
    if (current instanceof WindowSearchOverlay &&
        current._overlayContext?.type === 'all-windows') {
        SearchOverlayBase.closeCurrent();
        return false;
    }
    return showAllWindows();
}

export function showWorkspaceWindows(workspaceIndex) {
    const workspace = Model.WorkspaceManager.get_workspace_by_index(workspaceIndex);
    if (!workspace) throw new Error(`Workspace ${workspaceIndex} not found`);

    const focusedWindow =
        Model.Display.get_tab_current(Meta.TabList.NORMAL_ALL, workspace)
        ?? Model.Display.focus_window
        ?? null;

    workspace.activate(global.get_current_time());
    return showWindowOverlay(
        Model.getModelWindows(null),
        { type: 'workspace', workspaceIndex },
        focusedWindow,
        { workspace: workspaceIndex });
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

export function showGroupWindows(workspaceIndex, appId) {
    const entry = Model.buildModel().workspaces[workspaceIndex];
    if (!entry) return false;

    const group = entry.groups.find(g => g.appId === appId);
    if (!group || !group.windows.length) return false;

    const workspace = Model.WorkspaceManager.get_workspace_by_index(workspaceIndex);
    const initial = [
        Model.Display.focus_window,
        workspace ? Model.Display.get_tab_current(Meta.TabList.NORMAL_ALL, workspace) : null,
    ].find(w => w && group.windows.includes(w)) ?? group.windows[0];

    const opened = showWindowOverlay(
        Model.getModelWindows(null),
        { type: 'group', workspaceIndex, appId, appName: group.appName },
        initial,
        { workspace: workspaceIndex });
    journal(`[overlayService] showGroupWindows ws${workspaceIndex} ${group.appName} (${group.windows.length})`);
    return opened;
}

export function toggleGroupWindows(workspaceIndex, appId) {
    const current = SearchOverlayBase.current;
    if (current instanceof WindowSearchOverlay &&
        current._overlayContext?.type === 'group' &&
        current._overlayContext.workspaceIndex === workspaceIndex &&
        current._overlayContext.appId === appId) {
        SearchOverlayBase.closeCurrent();
        return false;
    }
    return showGroupWindows(workspaceIndex, appId);
}

export function closeOverlay() { return SearchOverlayBase.closeCurrent(); }

export function showDmenuItems(items, opts = {}, onResult = null) {
    if (!_settings) return false;
    SearchOverlayBase.closeCurrent();
    new GenericSearchOverlay(items, _settings, {
        multi: !!opts.multi,
        hint: opts.hint || null,
        controls: opts.controls ?? [],
        onResult,
    });
    return true;
}

export function initOverlayService(settings) { _settings = settings; }

export function destroyOverlayService() {
    closeOverlay();
    _settings = null;
}