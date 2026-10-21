// ===== FILE: ./lib/workspaceActions.js =====
// Window/workspace actions that are neither model state nor overlay logic.
// Shared by the DBus adapter, the top-bar scroll handler, the flyout,
// and every preview/activation path in the indicator and overlays.

import Meta from 'gi://Meta';

import * as Model from './model.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

/**
 * Bring `win` to the foreground on its own workspace. Maximizes only
 * NORMAL windows — a dialog or utility palette forced full-screen is
 * the wrong outcome. Window eligibility (which windows this extension
 * works with at all) is decided by Model, not here.
 *
 * Exceptions (dead window object, race during close) are swallowed
 * and logged — callers treat this as fire-and-forget.
 *
 * Note: the previous version had an inverted branch here that called
 * activate_with_workspace() with a null workspace whenever
 * get_workspace() returned null. Mutter switches workspace on its own
 * when activate() is called on a window on another workspace, so the
 * plain activate() call is sufficient.
 */
export function focusWindow(win) {
    if (!win) return;
    try {
        if (win.minimized) win.unminimize();
        if (Model.isNormalWindow(win)) win.maximize(Meta.MaximizeFlags.BOTH);
        win.activate(global.get_current_time());
    } catch (e) {
        journal(`[focusWindow] failed: ${e.message}`);
    }
}

export function scrollModelWindows(direction = 1) {
    const model = Model.buildModel();

    const windows = [];
    const seen = new Set();
    for (const entry of model.workspaces) {
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