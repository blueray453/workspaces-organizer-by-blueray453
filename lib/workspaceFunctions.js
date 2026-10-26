// ===== FILE: ./lib/workspaceFunctions.js =====
//
// Moved from gnome-utils. XML now lives in ./dbusService.js (the
// Workspaces interface). This file exports the seven implementation
// functions plus init()/destroy() for the workspace-switched signal
// that backs ToggleWorkspaces.

import Meta from 'gi://Meta';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const WorkspaceManager = global.get_workspace_manager();

const state = {
    lastWorkspace: 1,
    workspaceChangedId: 0,
};

function onWorkspaceSwitched(display, prev, current, direction) {
    state.lastWorkspace = prev;
}

export function GetCurrentWorkspace() {
    return JSON.stringify(WorkspaceManager.get_active_workspace().index());
}

export function GetWorkspaceIndexByName(workspaceName) {
    const n = WorkspaceManager.get_n_workspaces();
    for (let i = 0; i < n; i++) {
        if (Meta.prefs_get_workspace_name(i) == workspaceName) {
            return JSON.stringify(i);
        }
    }
}

export function GetWorkspaces() {
    const workspaces = [];
    const all_normal_windows_of_workspaces = {};
    const n = WorkspaceManager.get_n_workspaces();

    for (let wks = 0; wks < n; ++wks) {
        workspaces.push({ index: wks, name: Meta.prefs_get_workspace_name(wks) });

        const workspace_name = Meta.prefs_get_workspace_name(wks);
        const metaWorkspace = WorkspaceManager.get_workspace_by_index(wks);

        const all_normal_windows = [];
        metaWorkspace.list_windows()
            .filter(w => w.get_window_type() == 0)
            .map(w => all_normal_windows.push(w.get_id()));
        all_normal_windows_of_workspaces[workspace_name] = all_normal_windows;
    }

    return JSON.stringify({ workspaces, all_normal_windows_of_workspaces });
}

export function GoToGivenWorkspace(workspaceNum) {
    const current = WorkspaceManager.get_active_workspace();
    const given = WorkspaceManager.get_workspace_by_index(workspaceNum);
    if (given && given.index() !== current.index())
        given.activate(global.get_current_time());
}

export function MoveFocusedWindowToGivenWorkspace(workspaceNum) {
    const win = global.get_display().get_focus_window();
    if (!win)
        throw new Error('Not found');
    win.change_workspace_by_index(workspaceNum, false);
}

export function MoveWindowToWorkspace(win_id, workspaceNum) {
    const win = global.get_display().list_all_windows().find(w => w.get_id() == win_id);
    if (!win)
        throw new Error('Not found');
    win.change_workspace_by_index(workspaceNum, false);
}

export function ToggleWorkspaces() {
    WorkspaceManager.get_workspace_by_index(state.lastWorkspace)
        .activate(global.get_current_time());
}

// ---- lifecycle (called from dbusService.js's INTERFACES registry) ----

export function init() {
    state.lastWorkspace = 1;
    if (!state.workspaceChangedId)
        state.workspaceChangedId = WorkspaceManager.connect('workspace-switched', onWorkspaceSwitched);
}

export function destroy() {
    if (state.workspaceChangedId) {
        WorkspaceManager.disconnect(state.workspaceChangedId);
        state.workspaceChangedId = 0;
    }
}