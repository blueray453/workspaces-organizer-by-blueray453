// ===== FILE: ./lib/keybindingFunctions.js =====
//
// Moved from gnome-utils. XML now lives in ./dbusService.js (the
// Keybinding interface). This file exports the single implementation
// function (SwitchToWorkspace) plus the private helpers and the
// WORKSPACE_CONFIG data table.
//
// Two changes from the original:
//   1. callDBusMethod('…TopNotchWorkspaces…', 'CycleWindowsOnWorkspace', …)
//      became a direct WorkspaceActions.cycleWindowsOnWorkspace call.
//      Saves one DBus round trip and removes the last cross-extension
//      dependency.
//   2. callDBusMethod('…TopNotchWorkspaces…', 'CloseOverlay') became
//      OverlayService.closeOverlay() — same reasoning.
//   3. Workspace-7 branch: switch FIRST, then rearrange. Matches the
//      rule the rest of the file already uses ("go to the workspace,
//      then act on it"). The original rearranged while the user was
//      still on the old workspace.

import GLib from 'gi://GLib';

import * as Model from './model.js';
import * as WorkspaceActions from './workspaceActions.js';
import * as OverlayService from './overlayService.js';
import * as windowFunctions from './windowFunctions.js';
import * as keyboardSimulatorFunctions from './keyboardSimulatorFunctions.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const WorkspaceManager = global.get_workspace_manager();

const WORKSPACE_CONFIG = {
    "0": {
        apps: ["Alacritty"],
        launch: { "Alacritty": "alacritty" },
        extra: [],
    },
    "1": {
        apps: ["Nemo"],
        launch: { "Nemo": "nemo" },
        extra: ["close_duplicate_nemo"],
    },
    "2": {
        apps: ["Io.github.cboxdoerfer.FSearch"],
        launch: { "Io.github.cboxdoerfer.FSearch": "fsearch" },
        extra: ["select_all_fsearch"],
    },
    "3": {
        apps: ["VSCodium"],
        launch: { "VSCodium": "codium --reuse-window" },
        extra: [],
    },
    "4": {
        apps: ["firefox-esr", "Chromium", "Epiphany", "Tor Browser", "Brave-browser"],
        launch: {
            "firefox-esr": "firefox",
            "Chromium": "chromium",
            "Epiphany": "epiphany",
            "Tor Browser": "tor-browser",
        },
        extra: [],
        primary_launch: "firefox-esr",
    },
    "5": {
        apps: ["Audacious", "io.github.celluloid_player.Celluloid", "mpv"],
        launch: {
            "Audacious": "audacious",
            "io.github.celluloid_player.Celluloid": "celluloid",
            "mpv": "mpv",
        },
        extra: [],
    },
    "6": {
        apps: ["calibre", "Evince", "xchm"],
        launch: {
            "calibre": "calibre",
            "Evince": "evince",
            "xchm": "xchm",
        },
        extra: [],
    },
    // Workspace 7 is the catch-all — handled separately below.
};

function goToWorkspace(workspaceNum) {
    const current = WorkspaceManager.get_active_workspace();
    const target = WorkspaceManager.get_workspace_by_index(workspaceNum);
    if (target && target.index() !== current.index())
        target.activate(global.get_current_time());
}

function cycleWindowsCurrentWorkspace() {
    WorkspaceActions.cycleWindowsOnWorkspace(
        WorkspaceManager.get_active_workspace().index(), 1);
}

function rearrangeToWorkspaces(config) {
    // Build a map from WM_CLASS -> workspace number
    const wmClassToWorkspace = {};
    for (const [ws, data] of Object.entries(config)) {
        const wsNum = parseInt(ws);
        for (const wmClass of data.apps)
            wmClassToWorkspace[wmClass] = wsNum;
    }

    // Step 1: Move each known app window to its configured workspace
    for (const [wmClass, ws] of Object.entries(wmClassToWorkspace))
        windowFunctions.WindowsMoveToGivenWorkspaceGivenWMClass(wmClass, ws);

    // Step 2: Move all other windows (not in the map) to workspace 7
    const allKnownWmClasses = Object.keys(wmClassToWorkspace);
    const otherWindows = windowFunctions.GetWindowsExcludingGivenWMClass(allKnownWmClasses);

    let windowsArray = [];
    try {
        windowsArray = JSON.parse(otherWindows);
    } catch (e) {
        journal(`Failed to parse window list: ${e}`, true);
        return;
    }

    const workspace7 = WorkspaceManager.get_workspace_by_index(7);
    if (!workspace7) return;
    const others = windowsArray
        .map(w => Model.getWindowById(w.id))
        .filter(Boolean);
    WorkspaceActions.moveWindowsToWorkspace(others, workspace7);

    journal(`Rearranged windows: moved known apps to their workspaces, others to workspace 7`);
}

// Closing any leftover overlay from a previous invocation is a no-op
// when nothing is open. Then switch to the workspace.
function switchOrShowOverlay(workspaceNum) {
    OverlayService.closeOverlay();
    goToWorkspace(workspaceNum);
}

export function SwitchToWorkspace(workspaceNum) {
    const currentIndex = WorkspaceManager.get_active_workspace().index();
    const alreadyHere = currentIndex === workspaceNum;

    if (workspaceNum === 7) {
        // Switch first, then rearrange — matches the "go, then act" rule
        // the rest of the file uses. The user never sees windows being
        // yanked away from a workspace they're about to leave.
        if (!alreadyHere) switchOrShowOverlay(workspaceNum);
        rearrangeToWorkspaces(WORKSPACE_CONFIG);
        if (alreadyHere) cycleWindowsCurrentWorkspace();
        return;
    }

    const wsConfig = WORKSPACE_CONFIG[String(workspaceNum)];
    if (!wsConfig) {
        journal(`No config for workspace ${workspaceNum}`, true);
        return;
    }

    const { apps, launch, extra, primary_launch } = wsConfig;

    // 1. Cycle if already on this workspace, otherwise switch to it
    if (alreadyHere) {
        cycleWindowsCurrentWorkspace();
    } else {
        switchOrShowOverlay(workspaceNum);
        for (const wmClass of apps)
            windowFunctions.WindowsMoveToGivenWorkspaceGivenWMClass(wmClass, workspaceNum);
    }

    // 2. Launch apps only if the workspace has NO windows at all
    let windowCount = 0;
    try {
        windowCount = JSON.parse(windowFunctions.GetWindowCountCurrentWorkspace());
    } catch (e) {
        journal(`Failed to parse window count for workspace ${workspaceNum}: ${e}`, true);
    }

    if (windowCount === 0 && workspaceNum !== 5 && workspaceNum !== 6) {
        let cmd;
        if (primary_launch && launch[primary_launch])
            cmd = launch[primary_launch];
        else if (apps.length > 0 && launch[apps[0]])
            cmd = launch[apps[0]];

        if (cmd)
            GLib.spawn_command_line_async(cmd);
        else
            journal(`No launch command for workspace ${workspaceNum}`, true);
    }

    // 3. Extra actions
    for (const action of extra) {
        switch (action) {
            case 'select_all_fsearch':
                keyboardSimulatorFunctions.SelectAllFsearchText();
                break;
            case 'close_duplicate_nemo':
                windowFunctions.WindowsCloseDuplicateNemo();
                break;
            default:
                journal(`Unknown extra action: ${action}`, true);
        }
    }
}