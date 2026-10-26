// ===== FILE: ./lib/workspaceActions.js =====
//
// Window and workspace actions.
//
// ==================== MRU CONTRACT ====================
//
// Every function in this file that mutates Mutter's MRU ends with `Mru`:
//
//   navigateToWindowMru(win)              — unminimize + switch ws + focus
//   raiseAndMakeRecentMru(win)            — raise + recency bump (no focus)
//   activateWorkspaceWithFocusMru(ws, win) — switch ws + focus
//
// Functions without the suffix are MRU-neutral by design:
//
//   peekWindow(win, opts)                 — clone preview, no focus, no recency
//   stopPeek(immediate)                   — dismiss the peek
//   moveWindowsToWorkspace(wins, ws)      — change_workspace per window
//   scrollModelWindows(dir)               — delegates to cycleWindowsOnWorkspace
//   cycleWindowsOnWorkspace(i, dir)       — delegates to navigateToWindowMru
//
// Rule of thumb at call sites:
//   - User clicked / pressed Enter / pressed a hotkey → commit (Mru)
//   - User hovered / navigated / browsed → peek (no suffix)
//   - Script invoked a layout op (resize, move) → peek
//   - Script invoked "bring this forward" → commit
//
// ========================================================

import Meta from 'gi://Meta';

import * as Model from './model.js';
import { nextInMruCycle } from './mruCycle.js';
import { getPeek } from './peekController.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== MRU-mutating functions ====================

/**
 * Navigate to a window: unminimize if needed, switch to its workspace if
 * needed, and focus it.
 *
 * MUTATES MRU. Every call site must be a user gesture (click, Enter, hotkey
 * cycle, drop-to-commit). This is the single entry point for "bring this
 * window in front of the user".
 */
export function navigateToWindowMru(win) {
    if (!win) return;
    try {
        if (!win.showing_on_its_workspace()) win.unminimize();
        const activeWs = Model.WorkspaceManager.get_active_workspace();
        if (win.located_on_workspace(activeWs)) {
            win.activate(global.get_current_time());
        } else {
            const ws = win.get_workspace();
            if (ws) ws.activate_with_focus(win, global.get_current_time());
            else win.activate(global.get_current_time());
        }
    } catch (e) {
        journal(`[navigateToWindowMru] failed: ${e.message}`);
    }
}

/**
 * Raise a window and bump its MRU position on its own workspace.
 * MUTATES MRU. Focus is NOT touched.
 */
export function raiseAndMakeRecentMru(win) {
    if (!win) return;
    try {
        win.raise_and_make_recent_on_workspace(win.get_workspace());
    } catch (e) {
        journal(`[raiseAndMakeRecentMru] failed: ${e.message}`);
    }
}

/**
 * Switch to a workspace and focus a specific window there.
 * MUTATES MRU. Prefer navigateToWindowMru when you don't already have
 * the workspace object in hand.
 */
export function activateWorkspaceWithFocusMru(ws, win) {
    if (!ws || !win) return;
    try {
        ws.activate_with_focus(win, global.get_current_time());
    } catch (e) {
        journal(`[activateWorkspaceWithFocusMru] failed: ${e.message}`);
    }
}

// ==================== MRU-neutral functions ====================

/**
 * Show a centered clone of `win` without touching MRU, without focusing,
 * without switching workspaces. Use whenever the user's intent is "show
 * me what this looks like" rather than "put it in front of me".
 *
 * Peek is inherently MRU-neutral — no `Mru` suffix on the name.
 *
 * @param {Meta.Window} win
 * @param {{ below?: Clutter.Actor, parent?: Clutter.Actor, index?: number }} opts
 */
export function peekWindow(win, opts = {}) {
    if (!win) return;
    try {
        getPeek().start(win, { mode: 'clone', ...opts });
    } catch (e) {
        journal(`[peekWindow] failed: ${e.message}`);
    }
}

export function stopPeek(immediate = false) {
    try { getPeek().stop(immediate); }
    catch (e) { journal(`[stopPeek] failed: ${e.message}`); }
}

/**
 * Move windows to a workspace. Refuses to re-touch a window that is
 * already located there (which includes sticky windows — located_on_workspace
 * is true on every workspace for a sticky window).
 *
 * MRU-neutral: change_workspace does not affect recency.
 */
export function moveWindowsToWorkspace(wins, workspace) {
    if (!workspace) return;
    for (const w of wins) {
        if (!w) continue;
        if (w.located_on_workspace(workspace)) continue;
        try { w.change_workspace(workspace); }
        catch (e) { journal(`[moveWindowsToWorkspace] failed: ${e.message}`); }
    }
}

// ==================== Cycling ====================

/**
 * Cycle through windows on ALL workspaces in MRU order.
 * Backs the panel scroll wheel. Delegates the actual commit to
 * navigateToWindowMru.
 */
export function scrollModelWindows(direction = 1) {
    const mruWins = Model.Display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
    if (!mruWins.length) return false;

    const target = nextInMruCycle('global', mruWins, direction);
    if (!target) return false;
    navigateToWindowMru(target);
    return true;
}

/**
 * Cycle windows on ONE workspace in MRU order.
 * Backs the DBus CycleWindowsOnWorkspace method and SwitchToWorkspace's
 * same-workspace cycle. Delegates the commit to navigateToWindowMru.
 */
export function cycleWindowsOnWorkspace(workspaceIndex, direction = 1) {
    const ws = Model.WorkspaceManager.get_workspace_by_index(workspaceIndex);
    if (!ws) return false;

    const mruWins = Model.Display.get_tab_list(Meta.TabList.NORMAL_ALL, ws)
        .filter(w => w.located_on_workspace(ws));
    if (!mruWins.length) return false;

    const target = nextInMruCycle(`ws:${workspaceIndex}`, mruWins, direction);
    if (!target) return false;
    navigateToWindowMru(target);
    return true;
}