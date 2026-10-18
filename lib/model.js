// Domain state: the shell singletons, the shared constants, and the window
// model. Everything here is either a live handle grabbed once at module
// load, or a small piece of bookkeeping about the user's window order.
// Nothing in this file touches actors.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== SHELL SINGLETONS ====================
export const screenWidth = global.get_screen_width();
export const screenHeight = global.get_screen_height();
export const WorkspaceManager = global.get_workspace_manager();
export const Display = global.get_display();

// ==================== TUNABLE CONSTANTS ====================
export const TimeoutDelay = 200;

// Above this many windows on a workspace, the indicator switches from one
// icon per window to a single "N windows" overflow button, and top-bar
// scroll skips that workspace (there is no per-window order to walk).
// This is a DISPLAY-MODE threshold only. It never filters the window arrays
// consumed by overlays or menus — those always see every window.
export const DIRECT_MODE_MAX_WINDOWS = 5;

export const SettleAnimationDuration = 300;

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

// ==================== USER ORDER ====================
const ranks = new Map();
let nextRank = 1;

function isEligible(w) {
    return !w.skip_taskbar && !w.is_override_redirect();
}

// ==================== THE REPRESENTATION ====================
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
        // Display mode only — never used to filter `windows`.
        //   direct = true  → one icon per window in the strip, scroll steps per-window
        //   direct = false → single overflow button, scroll skips this workspace
        const direct = windows.length <= DIRECT_MODE_MAX_WINDOWS;
        workspaces.push({ workspace, index: i, windows, direct });
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
    for (const [obj, id] of _wsSignals) obj.disconnect(id);
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

    _listen(WorkspaceManager, 'notify::n-workspaces', () => { _watchWorkspaces(); requestRender(); });
    _listen(WorkspaceManager, 'workspace-switched', () => requestRender());
    _listen(Display, 'window-created', () => requestRender());
    _listen(Main.sessionMode, 'updated', () => requestRender());
    if (settings)
        _listen(settings, 'changed', () => requestRender());

    _watchWorkspaces();
}

export function disconnectModelSignals() {
    for (const [obj, id] of _wsSignals) obj.disconnect(id);
    for (const [obj, id] of _signals) obj.disconnect(id);
    _wsSignals = [];
    _signals = [];
    _settings = null;
}

// ==================== HELPERS FOR THE UI ====================
// Windows are returned in model order and are NEVER filtered by `direct`.
// Overlays and context menus depend on this.
export function getModelWindows(workspace = null) {
    const model = buildModel();
    if (workspace === null)
        return model.workspaces.flatMap(ws => ws.windows);
    const entry = model.workspaces.find(ws => ws.workspace === workspace);
    return entry ? entry.windows : [];
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
            windows: ws.windows.map(w => w.get_title() || 'Untitled'),
        })),
    };
}

export function logModel(model) {
    journal('[Model Snapshot]\n' + JSON.stringify(getModelSnapshot(model), null, 2));
}