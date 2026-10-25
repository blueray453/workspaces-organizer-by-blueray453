// ===== FILE: ./lib/mruCycle.js =====
// Shared MRU cycle state.
//
// Because activate_with_focus reorders MRU, a stateless "advance one from
// current focus" always toggles the top two windows. This module keeps a
// frozen snapshot + cursor for the duration of a rapid cycling session
// (RESET_MS), and invalidates on any signal that the user moved focus by
// other means.
//
// Scope keys used by callers:
//   'global'                 — scrollModelWindows (all windows)
//   `ws:${workspaceIndex}`   — cycleWindowsOnWorkspace
//   `group:${group.key}`     — _activateGroup (app group icon)

import GLib from 'gi://GLib';
import * as Model from './model.js';

const RESET_MS = 1500;

const _cycles = new Map();

export function resetCycle(scopeKey) {
    if (scopeKey !== undefined) _cycles.delete(scopeKey);
    else _cycles.clear();
}

/**
 * Advance one step through the MRU-ordered candidates for `scopeKey`.
 *
 *   • First call when focus is outside the candidate set → MRU-most-recent.
 *   • Subsequent calls within RESET_MS → next in the FROZEN snapshot, so
 *     MRU reordering after each activation doesn't collapse to a toggle.
 *   • After RESET_MS, or if focus moved by other means → rebuild snapshot
 *     from the current MRU list and advance one step from the new anchor.
 *
 * @param {string} scopeKey        unique context (see header).
 * @param {Meta.Window[]} mruList  MRU-ordered candidates.
 * @param {number} direction       +1 forward, -1 backward.
 * @returns {Meta.Window|null}     window to focus next, or null.
 */
export function nextInMruCycle(scopeKey, mruList, direction = 1) {
    if (!mruList || !mruList.length) return null;

    const candidates = mruList.filter(Boolean);
    if (!candidates.length) return null;

    const now = GLib.get_monotonic_time() / 1000;
    const focus = Model.focusedWindow();
    const dir = direction >= 0 ? 1 : -1;

    let state = _cycles.get(scopeKey);
    const anchor = state?.list?.[state.index];
    const stale = !state
        || (now - state.ts) > RESET_MS
        || !state.list.length
        || anchor !== focus;

    if (stale) {
        const focusIdx = candidates.indexOf(focus);
        if (focusIdx < 0) {
            // Focus is outside this context → first press goes to MRU-most-recent.
            _cycles.set(scopeKey, { list: candidates.slice(), index: 0, ts: now });
            return candidates[0];
        }
        state = { list: candidates.slice(), index: focusIdx, ts: now };
    }

    // Advance through the frozen snapshot. Skip closed windows without
    // resetting the cursor, so the cycle continues from where it was.
    for (let tries = 0; tries < state.list.length; tries++) {
        state.index = ((state.index + dir) % state.list.length + state.list.length)
            % state.list.length;
        const target = state.list[state.index];
        if (!target) continue;
        if (!candidates.includes(target)) continue;   // closed
        if (target === focus) continue;                // same window, try next
        state.ts = now;
        _cycles.set(scopeKey, state);
        return target;
    }

    // Every candidate skipped — save the (possibly advanced) state anyway
    // so the next call resumes from the same cursor rather than resetting.
    _cycles.set(scopeKey, state);
    return null;
}
