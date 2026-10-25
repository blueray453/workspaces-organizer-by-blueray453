// Window/workspace actions that are neither model state nor overlay logic.

import Meta from 'gi://Meta';

import * as Model from './model.js';

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
 * Cycle through windows in global MRU (Alt-Tab order, includes minimized).
 * Uses Meta.Display.get_tab_next directly; wraps manually since get_tab_next
 * returns null at the ends.
 */
export function scrollModelWindows(direction = 1) {
    const cur = Model.Display.focus_window;
    const backward = direction < 0;
    let next = Model.Display.get_tab_next(
        Meta.TabList.NORMAL_ALL, null, cur ?? null, backward);

    if (!next) {
        const list = Model.Display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
        if (!list.length) return false;
        next = backward ? list[list.length - 1] : list[0];
    }
    if (!next || next === cur) return false;
    navigateToWindow(next);
    return true;
}

/**
 * Cycle windows on ONE workspace (MRU within that workspace).
 * Uses an explicit filter, since get_tab_list(NORMAL_ALL, ws) includes
 * demand-attention windows from other workspaces.
 */
export function cycleWindowsOnWorkspace(workspaceIndex, direction = 1) {
    const ws = Model.WorkspaceManager.get_workspace_by_index(workspaceIndex);
    if (!ws) return false;

    const list = Model.Display.get_tab_list(Meta.TabList.NORMAL_ALL, ws)
        .filter(w => w.located_on_workspace(ws));
    if (!list.length) return false;

    const cur = Model.Display.focus_window;
    const curIdx = list.indexOf(cur);
    const dir = direction >= 0 ? 1 : -1;
    const nextIdx = curIdx < 0
        ? (dir > 0 ? 0 : list.length - 1)
        : ((curIdx + dir) % list.length + list.length) % list.length;

    navigateToWindow(list[nextIdx]);
    return true;
}