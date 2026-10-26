// ===== FILE: ./lib/windowFunctions.js =====
//
// Moved from gnome-utils. The D-Bus XML and the handler map now live in
// ./dbusService.js — this file exports the implementation functions
// directly. The 37 methods still surface on the same
// `io.github.blueray453.TopNotchWorkspaces.Windows` interface.
//
// Removed from the original:
//   - SharedEdgeChain, alignWindows, enableSharedEdgeChain,
//     enableAlignmentSharedEdges, edgeRatioKey, alignWindowsState
//   - moveWindowsSideBySide, WindowsMoveSideBySide
//   - AlignWindowsOfFocusedWindowWMClass
//   - focusWindow (all callers use WorkspaceActions.navigateToWindowMru)
//   - moveToWorkspace (all callers use WorkspaceActions.moveWindowsToWorkspace)
//   - isCoveredFully / isCoveredFullyOrPartially (now in ./coverage.js)
//   - isFileProgressWindow / excludeFileProgressWindows (now Model.isFileProgress)
//   - MR_DBUS_IFACE, dbusObject, init, destroy (now in ./dbusService.js)
//
// MRU contract (see ./workspaceActions.js header):
//   - WindowActivateGivenWinID / WindowMaximize / WindowFullScreen /
//     ToggleWindowsCurrentWorkspace commit — user gesture.
//   - WindowResize / WindowMoveResize peek — layout op, no focus steal.
//   - WindowsActivateGivenWMClass commits exactly once — single target.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Model from './model.js';
import * as WorkspaceActions from './workspaceActions.js';
import * as coverage from './coverage.js';
import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

const AppSystem = global.get_app_system();
const Display = global.get_display();
const WindowTracker = global.get_window_tracker();
const WorkspaceManager = global.get_workspace_manager();

const NEMO = "Nemo";

// ==================== Property helpers ====================

export function getPropertiesBriefGivenAppId(app_id) {
    if (!app_id)
        throw new Error('Not found');

    const shell_apps = AppSystem.lookup_app(app_id);
    if (!shell_apps)
        throw new Error('Not found');
    const desktop_apps = shell_apps.get_app_info();

    const windows_array = [];
    shell_apps.get_windows().forEach(w => windows_array.push(w.get_id()));

    return {
        app_name: desktop_apps.get_name(),
        app_file_name: desktop_apps.get_filename(),
        app_display_name: desktop_apps.get_display_name(),
        app_id: desktop_apps.get_id(),
        wm_class: desktop_apps.get_startup_wm_class(),
        app_pids: shell_apps.get_pids(),
        app_icon: shell_apps.get_icon()?.to_string(),
        app_windows_number: shell_apps.get_n_windows(),
        app_windows: windows_array,
        state: shell_apps.get_state(),
        description: shell_apps.get_description(),
        commandline: desktop_apps.get_commandline(),
        executable: desktop_apps.get_executable(),
    };
}

export function getPropertiesBriefGivenMetaWindow(win, show_is_covered = false) {
    const workspace_id = win.get_workspace().index();

    const obj = {
        id: win.get_id(),
        type: win.get_window_type(),
        title: win.get_title(),
        pid: win.get_pid(),
        wm_class: win.get_wm_class(),
        wm_class_instance: win.get_wm_class_instance(),
        workspace_id,
        workspace_name: Meta.prefs_get_workspace_name(workspace_id),
        monitor: win.get_monitor(),
    };

    if (show_is_covered)
        obj.is_covered = coverage.isCoveredFully(win);

    return obj;
}

// ==================== Window list helpers ====================

function getNormalWindows() {
    return Display.list_all_windows()
        .filter(Model.isTabWindow)
        .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
}

function getNormalWindowsCurrentWorkspace() {
    const current = WorkspaceManager.get_active_workspace();
    return getNormalWindows().filter(win => win.located_on_workspace(current));
}

function getNormalWindowsGivenWorkspace(index) {
    const workspace = WorkspaceManager.get_workspace_by_index(index);
    if (!workspace) return [];
    return getNormalWindows().filter(win => win.located_on_workspace(workspace));
}

function getNormalWindowsCurrentWorkspaceCurrentMonitor() {
    const current_monitor = Display.get_current_monitor();
    return getNormalWindowsCurrentWorkspace().filter(w => w.get_monitor() === current_monitor);
}

function getNormalWindowsCurrentWorkspaceOfFocusedWindowWmClass() {
    const win = Display.get_focus_window();
    if (!win) return [];
    return getNormalWindowsCurrentWorkspaceGivenWmClass(win.get_wm_class());
}

function getNormalWindowsCurrentWorkspaceGivenWmClass(wm_class) {
    return getNormalWindowsCurrentWorkspace().filter(w => w.get_wm_class() == wm_class);
}

function getNormalWindowsExcludingGivenWmClasses(wm_classes) {
    return getNormalWindows().filter(w => !wm_classes.includes(w.get_wm_class()));
}

function getNormalWindowGivenWindowId(win_id) {
    let win = getNormalWindows().find(w => w?.get_id() == win_id);
    return win ?? null;
}

function getNormalWindowsGivenWmClass(wm_class) {
    return getNormalWindows().filter(w => w.get_wm_class() == wm_class);
}

function getOtherNormalWindowsCurrentWorkspaceOfFocusedWindowWmClass() {
    const win = Display.get_focus_window();
    if (!win) return [];
    return getNormalWindowsCurrentWorkspaceGivenWmClass(win.get_wm_class())
        .filter(w => win !== w);
}

// ==================== Low-level window ops ====================

function moveResizeWindow(meta_window, x_coordinate, y_coordinate, width, height) {
    const maxState = meta_window.get_maximized();
    if (maxState & Meta.MaximizeFlags.BOTH)
        meta_window.unmaximize(Meta.MaximizeFlags.BOTH);

    let windowReadyId = 0;
    let unmanagingId = 0;

    const cleanup = () => {
        if (unmanagingId) {
            try { meta_window.disconnect(unmanagingId); } catch (e) { /* gone */ }
            unmanagingId = 0;
        }
    };

    windowReadyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
            meta_window.move_resize_frame(1, x_coordinate, y_coordinate, width, height);
            journal(`Alhamdulillah, moved meta_window`);
        } finally {
            windowReadyId = 0;
            cleanup();
        }
        return GLib.SOURCE_REMOVE;
    });

    unmanagingId = meta_window.connect('unmanaging', () => {
        if (windowReadyId) {
            try { GLib.Source.remove(windowReadyId); } catch (e) { /* gone */ }
            windowReadyId = 0;
        }
        unmanagingId = 0;
    });
}

// ==================== DBus methods ====================

export function CloseOtherWindowsCurrentWorkspaceOfFocusedWindowWMClass() {
    getOtherNormalWindowsCurrentWorkspaceOfFocusedWindowWmClass()
        .filter(w => !Model.isFileProgress(w))
        .forEach(w => w.delete(0));
}

export function GetAppFocusedWindow() {
    let app = WindowTracker.get_focus_app();
    if (!app) return JSON.stringify(null);
    return JSON.stringify(getPropertiesBriefGivenAppId(app.get_id()));
}

export function GetAppGivenAppID(app_id) {
    return JSON.stringify(getPropertiesBriefGivenAppId(app_id));
}

export function GetAppGivenPID(pid) {
    let app = WindowTracker.get_app_from_pid(pid);
    if (!app) return JSON.stringify(null);
    return JSON.stringify(getPropertiesBriefGivenAppId(app.get_id()));
}

export function GetAppGivenWindowID(win_id) {
    let win = getNormalWindowGivenWindowId(win_id);
    if (!win) return JSON.stringify(null);
    let app = WindowTracker.get_window_app(win);
    if (!app) return JSON.stringify(null);
    return JSON.stringify(getPropertiesBriefGivenAppId(app.get_id()));
}

export function GetAppGivenWMClass(wmclass) {
    let app = AppSystem.lookup_desktop_wmclass(wmclass);
    if (!app) return JSON.stringify(null);
    return JSON.stringify(getPropertiesBriefGivenAppId(app.get_id()));
}

export function GetAppsRunning() {
    let apps = AppSystem.get_running();
    let results = [];

    apps.forEach(app => {
        let app_id = app.get_id();
        try {
            results.push(getPropertiesBriefGivenAppId(app_id));
        } catch (err) {
            results.push({ app_id, error: err.message });
        }
    });

    return JSON.stringify(results);
}

export function GetAppsRunningGivenWMClass(wm_class) {
    let wins = getNormalWindowsGivenWmClass(wm_class);
    return JSON.stringify(wins.length > 0);
}

export function GetWindowFocused() {
    const win = Display.get_focus_window();
    if (!win) return JSON.stringify(null);
    return JSON.stringify(getPropertiesBriefGivenMetaWindow(win));
}

export function GetWindowGivenWindowID(win_id) {
    let win = getNormalWindowGivenWindowId(win_id);
    if (!win) return JSON.stringify(null);
    return JSON.stringify(getPropertiesBriefGivenMetaWindow(win, true));
}

export function GetWindows() {
    let wins = getNormalWindows();
    return JSON.stringify(wins.map(win => getPropertiesBriefGivenMetaWindow(win)));
}

export function GetWindowCountCurrentWorkspace() {
    return JSON.stringify(getNormalWindowsCurrentWorkspace().length);
}

export function GetWindowCountGivenWorkspace(index) {
    return JSON.stringify(getNormalWindowsGivenWorkspace(index).length);
}

export function GetWindowsCurrentWorkspace() {
    let wins = getNormalWindowsCurrentWorkspace();
    return JSON.stringify(wins.map(win => getPropertiesBriefGivenMetaWindow(win, true)));
}

export function GetWindowsCurrentWorkspaceCurrentMonitor() {
    let wins = getNormalWindowsCurrentWorkspaceCurrentMonitor();
    return JSON.stringify(wins.map(win => getPropertiesBriefGivenMetaWindow(win, true)));
}

export function GetWindowsCurrentWorkspaceOfFocusedWindowWMClass() {
    let wins = getNormalWindowsCurrentWorkspaceOfFocusedWindowWmClass();
    return JSON.stringify(wins.map(win => getPropertiesBriefGivenMetaWindow(win)));
}

export function ToggleWindowsCurrentWorkspace() {
    let windows = getNormalWindowsCurrentWorkspace();
    if (windows.length !== 2) return;

    let hiddenWindow = windows.find(w => !w.showing_on_its_workspace());
    if (hiddenWindow) {
        hiddenWindow.unminimize();
        hiddenWindow.maximize(3);
        WorkspaceActions.navigateToWindowMru(hiddenWindow);
        return;
    }

    let covered = windows.find(w => coverage.isCoveredPartially(w));
    if (!covered) return;

    WorkspaceActions.navigateToWindowMru(covered);
}

export function GetWindowsExcludingGivenWMClass(wm_classes) {
    let wins = getNormalWindowsExcludingGivenWmClasses(wm_classes);
    return JSON.stringify(wins.map(win => getPropertiesBriefGivenMetaWindow(win)));
}

export function GetWindowsGivenWMClass(wm_class) {
    let wins = getNormalWindowsGivenWmClass(wm_class);
    return JSON.stringify(wins.map(win => getPropertiesBriefGivenMetaWindow(win)));
}

export function ToggleLookingGlass() {
    if (Main.lookingGlass === null)
        Main.createLookingGlass();
    Main.lookingGlass.toggle();
}

export function MinimizeOtherWindowsOfFocusedWindowWMClass() {
    getOtherNormalWindowsCurrentWorkspaceOfFocusedWindowWmClass().forEach(w => w.minimize());
}

export function WindowActivateGivenWinID(win_id) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win === null) return;
    WorkspaceActions.navigateToWindowMru(win);
}

export function WindowCloseGivenWinID(win_id) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win !== null) win.delete(0);
}

export function WindowFullScreenGivenWinID(win_id) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win === null) return;
    // Was win.maximize(3) in the original — that's maximize, not fullscreen.
    // The method name says fullscreen; use the correct call.
    win.make_fullscreen();
    WorkspaceActions.navigateToWindowMru(win);
}

export function WindowMaximizeGivenWinID(win_id) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win === null) return;
    if (win.minimized) win.unminimize();
    win.maximize(3);
    WorkspaceActions.navigateToWindowMru(win);
}

export function WindowMinimizeGivenWinID(win_id) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win !== null) win.minimize();
}

export function WindowMoveGivenWinID(win_id, x, y) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win === null) return;
    const rect = win.get_frame_rect();
    moveResizeWindow(win, x, y, rect.width, rect.height);
}

export function WindowMoveResizeGivenWinID(win_id, x, y, width, height) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win === null) return;
    moveResizeWindow(win, x, y, width, height);
    // Peek — resize/move is a layout op, not a focus gesture.
    WorkspaceActions.peekWindow(win);
}

export function WindowMoveToCurrentWorkspace(win_id) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win === null) return;
    const current = WorkspaceManager.get_active_workspace();
    WorkspaceActions.moveWindowsToWorkspace([win], current);
}

export function WindowMoveToExcludingGivenWMClasses(wm_classes, workspace_num) {
    const target = WorkspaceManager.get_workspace_by_index(workspace_num);
    if (!target) return;
    const wins = getNormalWindowsExcludingGivenWmClasses(wm_classes);
    WorkspaceActions.moveWindowsToWorkspace(wins, target);
}

export function WindowMoveToGivenWorkspaceGivenWinID(win_id, workspace_num) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win === null) return;
    const target = WorkspaceManager.get_workspace_by_index(workspace_num);
    if (!target) return;
    WorkspaceActions.moveWindowsToWorkspace([win], target);
}

export function WindowRaiseGivenWinID(win_id) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win === null) return;
    WorkspaceActions.raiseAndMakeRecentMru(win);
}

export function WindowResizeGivenWinID(win_id, width, height) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win === null) return;
    const rect = win.get_frame_rect();
    moveResizeWindow(win, rect.x, rect.y, width, height);
    // Peek — resize is a layout op, not a focus gesture.
    WorkspaceActions.peekWindow(win);
}

export function WindowsActivateGivenWMClass(wm_class) {
    const wins = getNormalWindowsGivenWmClass(wm_class);
    if (wins.length === 0) return;
    // Pick the MRU-most window of the class and commit once. Mutating
    // every window of the class (the original behaviour) reshuffled the
    // whole class to the top of MRU, which is not what "activate this
    // app" usually means.
    const mru = Display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
    const target = mru.find(w => wins.includes(w)) ?? wins[0];
    WorkspaceActions.navigateToWindowMru(target);
}

export function WindowsCloseDuplicateNemo() {
    let wins = getNormalWindowsCurrentWorkspaceGivenWmClass(NEMO)
        .filter(w => !Model.isFileProgress(w));

    let seen = {};
    wins.forEach(win => {
        let key = win.get_title();
        if (!seen[key]) {
            seen[key] = win;
        } else {
            if (win.get_user_time() < seen[key].get_user_time()) {
                win.delete(0);
            } else {
                seen[key].delete(0);
                seen[key] = win;
            }
        }
    });
}

export function WindowsMoveToGivenWorkspaceGivenWMClass(wm_class, workspace_num) {
    const target = WorkspaceManager.get_workspace_by_index(workspace_num);
    if (!target) return;
    let wins = getNormalWindowsGivenWmClass(wm_class);
    WorkspaceActions.moveWindowsToWorkspace(wins, target);
}

export function WindowUnminimizeGivenWinID(win_id) {
    const win = getNormalWindowGivenWindowId(win_id);
    if (win !== null && win.minimized)
        win.unminimize();
}