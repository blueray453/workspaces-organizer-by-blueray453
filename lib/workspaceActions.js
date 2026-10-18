// Window/workspace actions that are neither model state nor overlay logic.
// Shared by the DBus adapter (CycleWindowsOnWorkspace) and the top-bar
// scroll handler.

import Meta from 'gi://Meta';

import * as Model from './model.js';

/**
 * Advance focus through the flat model order — every window across every
 * workspace that is NOT in overflow mode — by `direction` (+1 next,
 * -1 previous), wrapping at both ends.
 *
 * Workspaces with `direct === false` (i.e. >5 windows) are skipped
 * entirely: the strip shows a single count button for them, so there is
 * no per-window order to walk. Windows on overflow workspaces are simply
 * not in the cycle.
 *
 * Sticky windows (`on_all_workspaces`) appear in every workspace's list;
 * they are deduplicated so a flat walk hits each one once.
 *
 * The anchor is the focused window's position in that flat list; when it
 * isn't in the cycle (focused on an overflow workspace, on a desktop, or
 * no focus at all) we start at the end the direction points from.
 *
 * Does NOT maximize — this is "scroll through the strip", not the DBus
 * "cycle" action.
 */
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

/**
 * Focus the next (or previous) window on a *specific* workspace, in model
 * order. Kept workspace-scoped and maximizing for the DBus
 * CycleWindowsOnWorkspace method, whose contract is "cycle + focus at full
 * size" and is independent of the display mode.
 */
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

    if (target.minimized) target.unminimize();
    target.maximize(Meta.MaximizeFlags.BOTH);
    target.activate(global.get_current_time());
    return true;
}