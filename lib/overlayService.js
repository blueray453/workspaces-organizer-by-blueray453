// ===== FILE: ./lib/overlayService.js =====
import Meta from 'gi://Meta';

import { SearchOverlayBase } from './overlayBase.js';
import { WindowSearchOverlay } from './windowOverlay.js';
import { AppSearchOverlay } from './appOverlay.js';
import { GenericSearchOverlay } from './genericOverlay.js';
import * as Model from './model.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== OVERLAY SERVICE ====================
// The single place any search overlay is opened or closed.
//
// showWindowOverlay() passes all candidate windows plus an optional
// `initialFilters` object to pre-seed the filter bar. When
// `initialFilters` is null, the overlay uses whatever filters are
// currently persisted in `Model.intent.overlayFilters` — that's the
// "remember the filter across opens" behaviour.
//
// Filters are single-axis values:
//   { workspace: null|0..n, app: null|appId, recent: null|1..7, pinnedOnly: bool }

let _settings = null;

export function showWindowOverlay(windows, context = null, focusedWindow = null, initialFilters = null) {
    if (!_settings) {
        journal('[overlayService] showWindowOverlay before init — ignoring');
        return false;
    }
    SearchOverlayBase.closeCurrent();
    const overlay = new WindowSearchOverlay(windows, _settings, focusedWindow, initialFilters);
    overlay._overlayContext = context;
    return true;
}

export function showAllWindows(initialFilters = null) {
    if (!_settings) {
        journal('[overlayService] showAllWindows before init — ignoring');
        return false;
    }
    const activeIdx = Model.WorkspaceManager.get_active_workspace_index();
    const focusedWindow = Model.Display.focus_window
        ?? Model.lastFocusedWindow(activeIdx)
        ?? null;
    return showWindowOverlay(
        Model.getModelWindows(null),
        { type: 'all-windows' },
        focusedWindow,
        initialFilters);
}

export function showAllApps() {
    if (!_settings) {
        journal('[overlayService] showAllApps before init — ignoring');
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

/**
 * Toggle the all-windows overlay. Press once to open, again to close.
 * The app overlay is reached through ToggleAllApps, not by cycling.
 */
export function toggleAllWindows() {
    const current = SearchOverlayBase.current;
    if (current instanceof WindowSearchOverlay &&
        current._overlayContext?.type === 'all-windows') {
        SearchOverlayBase.closeCurrent();
        return false;
    }
    return showAllWindows();
}

/**
 * Show windows for a given workspace. The overlay opens pre-filtered to
 * that workspace; the user can clear the filter (Reset) to see all windows.
 */
export function showWorkspaceWindows(workspaceIndex) {
    const workspace = Model.WorkspaceManager.get_workspace_by_index(workspaceIndex);
    if (!workspace) throw new Error(`Workspace ${workspaceIndex} not found`);

    const focusedWindow = Model.Display.get_tab_list(Meta.TabList.NORMAL, workspace)[0]
        ?? Model.lastFocusedWindow(workspaceIndex)
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

/**
 * Show windows for a given (workspace, app) group. Pre-filters to
 * workspace, but leaves the app filter off so the user can broaden
 * back to "all windows on this workspace" with one click.
 * (Different from the old behaviour — pass `null` focusedWindow so
 * the group's own representative doesn't get lost if the app has more
 * than one window on this workspace.)
 */
export function showGroupWindows(workspaceIndex, appId) {
    const entry = Model.buildModel().workspaces[workspaceIndex];
    if (!entry) return false;

    const group = entry.groups.find(g => g.appId === appId);
    if (!group || !group.windows.length) return false;

    const initial = [Model.Display.focus_window, Model.lastFocusedWindow(workspaceIndex)]
        .find(w => w && group.windows.includes(w)) ?? group.windows[0];

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

// -------------------- Dmenu-style picker --------------------
// `Show(items)` reports its result through the Selected / Cancelled
// D-Bus signals (see dbusService.js). `onResult` fires exactly once per
// invocation: an array of labels, or `null` on cancellation.
export function showDmenuItems(items, opts = {}, onResult = null) {
    if (!_settings) {
        journal('[overlayService] showDmenuItems before init — ignoring');
        return false;
    }
    SearchOverlayBase.closeCurrent();
    new GenericSearchOverlay(items, _settings, {
        multi: !!opts.multi,
        hint: opts.hint || null,
        controls: opts.controls ?? [],
        onResult,
    });
    return true;
}

// -------------------- Lifecycle --------------------
export function initOverlayService(settings) { _settings = settings; }

export function destroyOverlayService() {
    closeOverlay();
    _settings = null;
}