// ===== FILE: ./lib/workspaceActions.js =====
// Window/workspace actions that are neither model state nor overlay logic.

import Meta from 'gi://Meta';

import * as Model from './model.js';
import { nextInMruCycle } from './mruCycle.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

/**
 * Navigate to a window: unminimize + activate_with_focus on its own
 * workspace. No maximize. Only call from an explicit user gesture
 * (Enter, click, DBus cycle) — never from hover, scroll, or filter.
 */
export function navigateToWindow(win) {
    if (!win) return;
    try {
        if (win.minimized) win.unminimize();
        const ws = win.get_workspace();
        if (ws) ws.activate_with_focus(win, global.get_current_time());
        else win.activate(global.get_current_time());
    } catch (e) {
        journal(`[navigateToWindow] failed: ${e.message}`);
    }
}

/**
 * Cycle through windows on ALL workspaces in MRU order.
 * Backs the panel scroll wheel.
 */
export function scrollModelWindows(direction = 1) {
    const mruWins = Model.Display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
    if (!mruWins.length) return false;

    const target = nextInMruCycle('global', mruWins, direction);
    if (!target) return false;
    navigateToWindow(target);
    return true;
}

/**
 * Cycle windows on ONE workspace in MRU order.
 * Backs the DBus CycleWindowsOnWorkspace method.
 */
export function cycleWindowsOnWorkspace(workspaceIndex, direction = 1) {
    const ws = Model.WorkspaceManager.get_workspace_by_index(workspaceIndex);
    if (!ws) return false;

    const mruWins = Model.Display.get_tab_list(Meta.TabList.NORMAL_ALL, ws)
        .filter(w => w.located_on_workspace(ws));
    if (!mruWins.length) return false;

    const target = nextInMruCycle(`ws:${workspaceIndex}`, mruWins, direction);
    if (!target) return false;
    navigateToWindow(target);
    return true;
}