// Window/workspace actions that are neither model state nor overlay logic.
// Shared by the DBus adapter, the top-bar scroll handler, the flyout,
// and every preview/activation path in the indicator and overlays.

import Meta from 'gi://Meta';

import * as Model from './model.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

/**
 * Bring `win` to the foreground on its own workspace, optionally
 * maximizing it. The one place for the unminimize / maximize /
 * activate_with_focus ritual, so every preview, activation, hover
 * and cycle path produces the same visual and focus outcome.
 *
 * Exceptions (dead window object, race during close) are swallowed
 * and logged — callers treat this as fire-and-forget.
 */
export function focusWindow(win) {
    if (!win) return;
    try {
        if (win.minimized) win.unminimize();
        win.maximize(Meta.MaximizeFlags.BOTH);
        const ws = win.get_workspace();
        if (ws) win.activate(global.get_current_time());
        else win.activate_with_workspace(global.get_current_time(), ws);
    } catch (e) {
        journal(`[focusWindow] failed: ${e.message}`);
    }
}

export function scrollModelWindows(direction = 1) {
    const model = Model.buildModel();

    const windows = [];
    const seen = new Set();
    for (const entry of model.workspaces) {
        if (!entry.direct) continue;
        for (const w of entry.windows) {
            const id = w.get_id();
            if (seen.has(id)) continue;
            seen.add(id);
            windows.push(w);
        }
    }
    if (windows.length === 0) return false;

    const n = windows.length;
    const idx = windows.indexOf(Model.Display.focus_window);
    const nextIdx = idx === -1
        ? (direction > 0 ? 0 : n - 1)
        : ((idx + direction) % n + n) % n;
    const target = windows[nextIdx];

    if (target.minimized) target.unminimize();
    const ws = target.get_workspace();
    if (ws) ws.activate_with_focus(target, global.get_current_time());
    else target.activate(global.get_current_time());
    return true;
}

export function cycleWindowsOnWorkspace(workspaceIndex, direction = 1) {
    const entry = Model.buildModel().workspaces[workspaceIndex];
    if (!entry || entry.windows.length === 0) return false;

    const windows = entry.windows;
    const n = windows.length;
    const idx = windows.indexOf(Model.Display.focus_window);

    const nextIdx = idx === -1
        ? (direction > 0 ? 0 : n - 1)
        : ((idx + direction) % n + n) % n;
    const target = windows[nextIdx];

    focusWindow(target);
    return true;
}