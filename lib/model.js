// ===== FILE: ./lib/model.js =====
// Domain state: shell singletons, shared constants, the window model and
// the workspace-local app grouping that both the indicator and the
// flyout consume. Nothing here touches actors.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== SHELL SINGLETONS ====================
export const screenWidth = global.get_screen_width();
export const screenHeight = global.get_screen_height();
export const WorkspaceManager = global.get_workspace_manager();
export const Display = global.get_display();

// ==================== TUNABLE CONSTANTS ====================
export const TimeoutDelay = 200;           // poll/debounce — never reduced

// Animation durations. Reassigned by applySettings(); live bindings
// make every reader pick up new values without re-import.
export let FadeInDuration = 200;
export let SettleAnimationDuration = 300;

// Grouping threshold. Reassigned by applySettings().
export let DIRECT_MODE_MAX_WINDOWS = 5;

let _reduceMotion = false;

/** True when reduce-motion is on. */
export function reduceMotion() { return _reduceMotion; }

/** Returns `ms`, or 0 when reduce-motion is enabled. */
export function animationDuration(ms) { return _reduceMotion ? 0 : ms; }

/**
 * Sync settings-backed constants. Idempotent. Called from
 * connectModelSignals() at startup and on every settings change so
 * that direct-mode-max-windows and reduce-motion take effect live.
 */
export function applySettings(settings) {
    if (!settings) return;
    DIRECT_MODE_MAX_WINDOWS = settings.get_int('direct-mode-max-windows');
    _reduceMotion = settings.get_boolean('reduce-motion');
    FadeInDuration = _reduceMotion ? 0 : 200;
    SettleAnimationDuration = _reduceMotion ? 0 : 300;
}

// ==================== INTENT (transient UI flags) ====================
export const intent = { drag: null, hintWs: null, menuOpen: false };

let _onIntent = () => { };
let _onWorld = () => { };

export function onIntentChange(cb) { _onIntent = cb ?? (() => { }); }
export function onWorldChange(cb) { _onWorld = cb ?? (() => { }); }

export function requestRender() { _onWorld(); }

export function resetIntent() {
    intent.drag = null;
    intent.hintWs = null;
    intent.menuOpen = false;
}

export function setIntent(patch) {
    let dirty = false;
    for (const key of Object.keys(patch)) {
        if (intent[key] !== patch[key]) { intent[key] = patch[key]; dirty = true; }
    }
    if (dirty) _onIntent();
}

// ==================== WINDOW SET ====================
// The single filter that decides which Meta.Windows the whole extension
// works with. Matches Mutter's Meta.TabList.NORMAL set plus the usual
// skip_taskbar / override-redirect exclusions. Every entry point in
// every module reads windows through Model — none of them re-checks.
//
// Excluded on purpose: DESKTOP (Nemo/Nautilus desktop), DOCK (Plank/
// Latte), TOOLBAR / MENU / DROPDOWN_MENU / POPUP_MENU / TOOLTIP /
// NOTIFICATION / COMBO / DND (transient chrome), SPLASHSCREEN,
// OVERRIDE_OTHER (caught by is_override_redirect anyway).

function isEligible(w) {
    if (!w) return false;
    if (w.skip_taskbar || w.is_override_redirect()) return false;
    const t = w.get_window_type();
    return t === Meta.WindowType.NORMAL
        || t === Meta.WindowType.DIALOG
        || t === Meta.WindowType.MODAL_DIALOG
        || t === Meta.WindowType.UTILITY;
}

/** Policy: does this action apply to ordinary app windows only? */
export function isNormalWindow(win) {
    return win?.get_window_type() === Meta.WindowType.NORMAL;
}

/** The focused window, if the extension works with it; else null. */
export function focusedWindow() {
    return isEligible(Display.focus_window) ? Display.focus_window : null;
}

// ==================== USER ORDER ====================
const ranks = new Map();
let nextRank = 1;

// ==================== LAST FOCUSED PER WORKSPACE ====================
const lastFocusedByWs = new Map();

// ==================== FOCUS HISTORY SUPPRESSION ====================
// Preview reveals activate a window only to SHOW it. That must not
// rewrite the per-workspace "last focused" memory. holdFocusHistory()
// returns an idempotent release — safe to call from _activateResult and
// _close, or twice from an external-poll teardown.
let _focusHolds = 0;

export function holdFocusHistory() {
    _focusHolds++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (_focusHolds > 0) _focusHolds--;
    };
}

export function noteFocusedWindow() {
    if (_focusHolds > 0) return;
    const window = focusedWindow();
    if (!window) return;
    try {
        const ws = window.get_workspace();
        if (ws) lastFocusedByWs.set(ws.index(), window);
    } catch (e) { /* dead window object */ }
}

export function lastFocusedWindow(workspaceIndex) {
    const win = lastFocusedByWs.get(workspaceIndex);
    if (!win) return null;
    try {
        const ws = win.get_workspace();
        if (!ws || ws.index() !== workspaceIndex) {
            lastFocusedByWs.delete(workspaceIndex);
            return null;
        }
    } catch (e) {
        lastFocusedByWs.delete(workspaceIndex);
        return null;
    }
    return win;
}

// ==================== APP IDENTITY / GROUPING ====================
export function appIdentity(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    if (app) {
        const id = app.get_id();
        if (id) return { id, name: app.get_name() || id };
    }
    const wm = window.get_wm_class() || window.get_wm_class_instance() || 'unknown';
    return { id: `wm:${wm}`, name: wm };
}

export function groupKey(workspaceIndex, appId) {
    return `${workspaceIndex}::${appId}`;
}

export function groupWindowsInWorkspace(entry) {
    const out = [];
    const byId = new Map();
    entry.windows.forEach((w, i) => {
        const { id, name } = appIdentity(w);
        let g = byId.get(id);
        if (!g) {
            g = {
                appId: id, appName: name,
                key: groupKey(entry.index, id),
                windows: [], indices: [], count: 0,
            };
            byId.set(id, g);
            out.push(g);
        }
        g.windows.push(w);
        g.indices.push(i);
        g.count++;
    });
    return out;
}

// ==================== THE REPRESENTATION ====================
export function buildModel() {
    const live = Display.list_all_windows().filter(isEligible);

    const liveSet = new Set(live);
    for (const w of [...ranks.keys()])
        if (!liveSet.has(w)) ranks.delete(w);
    for (const w of live)
        if (!ranks.has(w)) ranks.set(w, nextRank++);

    for (const [idx, win] of lastFocusedByWs)
        if (!liveSet.has(win)) lastFocusedByWs.delete(idx);

    const workspaces = [];
    for (let i = 0; i < WorkspaceManager.n_workspaces; i++) {
        const workspace = WorkspaceManager.get_workspace_by_index(i);
        const windows = live
            .filter(w => w.located_on_workspace(workspace))
            .sort((a, b) => ranks.get(a) - ranks.get(b));

        const entry = {
            workspace, index: i, windows,
            direct: windows.length <= DIRECT_MODE_MAX_WINDOWS,
        };
        entry.groups = groupWindowsInWorkspace(entry);
        workspaces.push(entry);
    }
    return { workspaces, drag: intent.drag, hintWs: intent.hintWs };
}

// ==================== MODEL MUTATIONS ====================
export function placeWindow(window, workspace, index = null) {
    const fullList = buildModel().workspaces[workspace.index()].windows;
    const list = fullList.filter(w => w !== window);

    let at = index === null ? list.length : index;
    at = Math.max(0, Math.min(at, list.length));

    list.splice(at, 0, window);

    for (const w of list) ranks.set(w, nextRank++);
}

// ==================== MODEL-OWNED SIGNALS ====================
let _signals = [];
let _wsSignals = [];
let _settings = null;

function _listen(obj, signal, cb) { _signals.push([obj, obj.connect(signal, cb)]); }

function _watchWorkspaces() {
    for (const [obj, id] of _wsSignals) {
        try { obj.disconnect(id); } catch (e) { /* already gone */ }
    }
    _wsSignals = [];
    for (let i = 0; i < WorkspaceManager.n_workspaces; i++) {
        const ws = WorkspaceManager.get_workspace_by_index(i);
        _wsSignals.push([ws, ws.connect('window-added', () => requestRender())]);
        _wsSignals.push([ws, ws.connect('window-removed', () => requestRender())]);
    }
}

export function connectModelSignals(settings = null) {
    disconnectModelSignals();
    _settings = settings;

    if (settings) applySettings(settings);

    _listen(WorkspaceManager, 'notify::n-workspaces', () => { _watchWorkspaces(); requestRender(); });
    _listen(WorkspaceManager, 'workspace-switched', () => requestRender());
    _listen(Display, 'window-created', () => requestRender());
    _listen(Display, 'notify::focus-window', () => noteFocusedWindow());
    _listen(Main.sessionMode, 'updated', () => requestRender());
    if (settings) {
        _listen(settings, 'changed', () => {
            applySettings(settings);
            requestRender();
        });
    }

    _watchWorkspaces();
    noteFocusedWindow();
}

export function disconnectModelSignals() {
    for (const [obj, id] of _wsSignals) {
        try { obj.disconnect(id); } catch (e) { /* already gone */ }
    }
    for (const [obj, id] of _signals) {
        try { obj.disconnect(id); } catch (e) { /* already gone */ }
    }
    _wsSignals = [];
    _signals = [];
    _settings = null;
}

// ==================== HELPERS FOR THE UI ====================
export function getModelWindows(workspace = null) {
    const model = buildModel();
    if (workspace === null)
        return model.workspaces.flatMap(ws => ws.windows);
    const entry = model.workspaces.find(ws => ws.workspace === workspace);
    return entry ? entry.windows : [];
}

export function getWorkspaceGroups(workspaceIndex) {
    const entry = buildModel().workspaces[workspaceIndex];
    return entry ? entry.groups : [];
}

export function getGroupWindows(workspaceIndex, appId) {
    return getWorkspaceGroups(workspaceIndex).find(g => g.appId === appId) ?? null;
}

// ==================== SNAPSHOT / LOGGING ====================
export function getModelSnapshot(model) {
    return {
        drag: !!model.drag,
        hintWs: model.hintWs,
        workspaces: model.workspaces.map(ws => ({
            index: ws.index,
            windowCount: ws.windows.length,
            direct: ws.direct,
            groups: ws.groups.map(g => `${g.appName}:${g.count}`),
        })),
    };
}

export function logModel(model) {
    journal('[Model Snapshot]\n' + JSON.stringify(getModelSnapshot(model), null, 2));
}