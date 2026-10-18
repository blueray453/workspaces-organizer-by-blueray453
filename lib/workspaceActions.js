// Window/workspace actions that are neither model state nor overlay logic.
// They mutate Meta windows directly and are shared by the DBus adapter
// (CycleWindowsOnWorkspace) and the top-bar scroll handler.

import Meta from 'gi://Meta';

import { buildModel, Display } from './model.js';

/**
 * Advance focus through the *current workspace's* windows in model order
 * by `direction` (+1 next, -1 previous), wrapping at both ends.
 *
 * The anchor is the focused window's position in that list; when the
 * focused window isn't on this workspace (or there's no focus at all)
 * we start at the end the direction points from.
 *
 * Does NOT maximize — this is "scroll through the strip", not the DBus
 * "cycle" action.
 *
 * Returns true if a window was focused.
 */
export function scrollModelWindows(direction = 1) {
    const wsIndex = global.workspace_manager.get_active_workspace_index();
    const entry = buildModel().workspaces[wsIndex];
    if (!entry || entry.windows.length === 0) return false;

    const windows = entry.windows;
    const n = windows.length;
    const idx = windows.indexOf(Display.focus_window);

    const nextIdx = idx === -1
        ? (direction > 0 ? 0 : n - 1)
        : ((idx + direction) % n + n) % n;
    const target = windows[nextIdx];

    if (target.minimized) target.unminimize();
    entry.workspace.activate_with_focus(target, global.get_current_time());
    return true;
}

/**
 * Focus the next (or previous) window on a *specific* workspace, in model
 * order. Kept workspace-scoped and maximizing for the DBus
 * CycleWindowsOnWorkspace method, whose contract is "cycle + focus at full
 * size" — different from scrolling through the strip.
 *
 * Returns true if a window was activated.
 */
export function cycleWindowsOnWorkspace(workspaceIndex, direction = 1) {
    const entry = buildModel().workspaces[workspaceIndex];
    if (!entry || entry.windows.length === 0) return false;

    const windows = entry.windows;
    const n = windows.length;
    const idx = windows.indexOf(Display.focus_window);

    const nextIdx = idx === -1
        ? (direction > 0 ? 0 : n - 1)
        : ((idx + direction) % n + n) % n;
    const target = windows[nextIdx];

    if (target.minimized) target.unminimize();
    target.maximize(Meta.MaximizeFlags.BOTH);
    target.activate(global.get_current_time());
    return true;
}