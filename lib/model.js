import { Display, WorkspaceManager } from './shellGlobals.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== INTENT (transient UI flags) ====================
// drag:     { window, sourceIcon, target: {wsIndex, index} | null } | null
// hintWs:   workspace index whose name tooltip is showing
// menuOpen: a context menu is open (renders are deferred)
export const intent = { drag: null, hintWs: null, menuOpen: false };

let _onChange = () => { };
export function onIntentChange(cb) { _onChange = cb ?? (() => { }); }
export function requestRender() { _onChange(); }
export function resetIntent() { intent.drag = null; intent.hintWs = null; intent.menuOpen = false; }

export function setIntent(patch) {
    let dirty = false;
    for (const key of Object.keys(patch)) {
        if (intent[key] !== patch[key]) { intent[key] = patch[key]; dirty = true; }
    }
    if (dirty) _onChange();
}

export function setDragTarget(target) {
    const drag = intent.drag;
    if (!drag) return;
    if (drag.target?.wsIndex === target?.wsIndex && drag.target?.index === target?.index) return;
    intent.drag = { ...drag, target };
    _onChange();
}

// ==================== USER ORDER (the only persistent state) ====================
const ranks = new Map(); // Meta.Window -> number
let nextRank = 1;

function isEligible(w) {
    return !w.skip_taskbar && !w.is_override_redirect();
}

// ==================== THE REPRESENTATION ====================
// Rebuilt from scratch from Mutter's live windows on every call.
export function buildModel() {
    const live = Display.list_all_windows().filter(isEligible);

    const liveSet = new Set(live);
    for (const w of [...ranks.keys()])
        if (!liveSet.has(w)) ranks.delete(w);
    for (const w of live)
        if (!ranks.has(w)) ranks.set(w, nextRank++);

    const workspaces = [];
    for (let i = 0; i < WorkspaceManager.n_workspaces; i++) {
        const workspace = WorkspaceManager.get_workspace_by_index(i);
        const windows = live
            .filter(w => w.located_on_workspace(workspace))
            .sort((a, b) => ranks.get(a) - ranks.get(b));
        workspaces.push({ workspace, index: i, windows });
    }
    return { workspaces, drag: intent.drag, hintWs: intent.hintWs };
}

// Put `window` at `index` (null = end) in `workspace`'s order. This only
// rewrites ranks; the caller moves the window itself. There's no
// suppression, no pending map: the next buildModel() just sees the result.
export function placeWindow(window, workspace, index = null) {
    const fullList = buildModel().workspaces[workspace.index()].windows;
    const originalIndex = fullList.indexOf(window);
    const list = fullList.filter(w => w !== window);

    let at = index === null ? list.length : index;

    // --- DEBUG LOGGING ---
    const winTitle = window.get_title ? window.get_title() : 'Unknown';
    journal(`\n[placeWindow] === DROP EVENT ===`);
    journal(`[placeWindow] Window: "${winTitle}"`);
    journal(`[placeWindow] UI Requested Index: ${index}`);
    journal(`[placeWindow] Original Index in Target WS: ${originalIndex}`);
    journal(`[placeWindow] Filtered List Length: ${list.length}`);
    // ---------------------

    // TEMPORARILY DISABLED TO SEE RAW BEHAVIOR:
    // if (originalIndex !== -1 && at > originalIndex) {
    //     at -= 1;
    // }

    at = Math.max(0, Math.min(at, list.length));

    // --- DEBUG LOGGING ---
    journal(`[placeWindow] Final Splice Index: ${at}`);
    journal(`[placeWindow] ====================\n`);
    // ---------------------

    list.splice(at, 0, window);

    for (const w of list) ranks.set(w, nextRank++);
}
