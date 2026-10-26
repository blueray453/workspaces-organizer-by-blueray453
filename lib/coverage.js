// ===== FILE: ./lib/coverage.js =====
//
// Window coverage checks. Two functions:
//
//   isCoveredFully(win)     — every pixel of win's frame rect is covered
//                             by a window stacked above it.
//   isCoveredPartially(win) — any pixel of win's frame rect intersects a
//                             window stacked above it.
//
// Both are MRU-neutral: reading is side-effect free.
//
// Both share the same set: normal + dialog windows that are located on
// the active workspace. Uses showing_on_its_workspace() throughout so
// minimized / unmapped / shaded windows are correctly excluded from both
// the target and the covering set.

import Meta from 'gi://Meta';

import * as Model from './model.js';

const Display = global.get_display();
const WorkspaceManager = global.get_workspace_manager();

function _stackedOnActiveWorkspace() {
    const current = WorkspaceManager.get_active_workspace();
    const wins = Display.list_all_windows().filter(win => {
        const t = win.get_window_type();
        return (t === Meta.WindowType.NORMAL || t === Meta.WindowType.DIALOG)
            && win.located_on_workspace(current);
    });
    return Display.sort_windows_by_stacking(wins);
}

function _clip(rect, area) {
    return {
        l: Math.max(rect.x, area.x),
        t: Math.max(rect.y, area.y),
        r: Math.min(rect.x + rect.width, area.x + area.width),
        b: Math.min(rect.y + rect.height, area.y + area.height),
    };
}

export function isCoveredFully(window) {
    if (!window.showing_on_its_workspace()) return false;

    const stacked = _stackedOnActiveWorkspace();
    const index = stacked.indexOf(window);
    if (index === -1) return false;

    const area = WorkspaceManager.get_active_workspace()
        .get_work_area_for_monitor(window.get_monitor());
    const t = _clip(window.get_frame_rect(), area);
    if (t.r <= t.l || t.b <= t.t) return false;

    const covers = [];
    for (let i = index + 1; i < stacked.length; i++) {
        const other = stacked[i];
        if (!other.showing_on_its_workspace()) continue;
        if (other.get_transient_for() === window) continue;
        const o = _clip(other.get_frame_rect(), area);
        if (o.r <= o.l || o.b <= o.t) continue;
        if (o.l >= t.r || o.r <= t.l || o.t >= t.b || o.b <= t.t) continue;
        covers.push(o);
    }
    if (covers.length === 0) return false;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const xs = [...new Set([t.l, t.r,
    ...covers.flatMap(o => [clamp(o.l, t.l, t.r), clamp(o.r, t.l, t.r)])])]
        .sort((a, b) => a - b);
    const ys = [...new Set([t.t, t.b,
    ...covers.flatMap(o => [clamp(o.t, t.t, t.b), clamp(o.b, t.t, t.b)])])]
        .sort((a, b) => a - b);

    for (let xi = 0; xi < xs.length - 1; xi++) {
        const cx = (xs[xi] + xs[xi + 1]) / 2;
        for (let yi = 0; yi < ys.length - 1; yi++) {
            const cy = (ys[yi] + ys[yi + 1]) / 2;
            if (!covers.some(o => cx > o.l && cx < o.r && cy > o.t && cy < o.b))
                return false;
        }
    }
    return true;
}

export function isCoveredPartially(window) {
    if (!window.showing_on_its_workspace()) return false;

    const stacked = _stackedOnActiveWorkspace();
    const index = stacked.indexOf(window);
    if (index === -1) return false;

    const area = WorkspaceManager.get_active_workspace()
        .get_work_area_for_monitor(window.get_monitor());
    const t = _clip(window.get_frame_rect(), area);
    if (t.r <= t.l || t.b <= t.t) return false;

    for (let i = index + 1; i < stacked.length; i++) {
        const other = stacked[i];
        if (!other.showing_on_its_workspace()) continue;
        if (other.get_transient_for() === window) continue;
        const o = _clip(other.get_frame_rect(), area);
        if (o.r <= o.l || o.b <= o.t) continue;
        if (t.l < o.r && t.r > o.l && t.t < o.b && t.b > o.t) return true;
    }
    return false;
}
