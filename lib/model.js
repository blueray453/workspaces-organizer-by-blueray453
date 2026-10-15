import { Display, WorkspaceManager } from './shellGlobals.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== INTENT (transient UI flags) ====================
// drag:     { window, sourceIcon, target: {wsIndex, index} | null } | null
// hintWs:   workspace index whose name tooltip is showing
// menuOpen: a context menu is open (renders are deferred)
export const intent = { drag: null, hintWs: null, menuOpen: false };

// Two distinct change channels:
//   _onIntent — a transient UI flag changed (drag / hintWs / menuOpen).
//               Cheap; subscribers may react synchronously without a
//               full render (e.g. repositioning a tooltip).
//   _onWorld  — the world/state changed and a render is required.
let _onIntent = () => { };
let _onWorld = () => { };

export function onIntentChange(cb) { _onIntent = cb ?? (() => { }); }
export function onWorldChange(cb) { _onWorld = cb ?? (() => { }); }

/** Request a rebuild of any UI derived from buildModel(). */
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

export function setDragTarget(target) {
    const drag = intent.drag;
    if (!drag) return;
    if (drag.target?.wsIndex === target?.wsIndex && drag.target?.index === target?.index) return;
    intent.drag = { ...drag, target };
    _onIntent();
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

// ==================== MODEL MUTATIONS ====================
// Put `window` at `index` (null = end) in `workspace`'s order. This only
// rewrites ranks; the caller moves the window itself. There's no
// suppression, no pending map: the next buildModel() just sees the result.
export function placeWindow(window, workspace, index = null) {
    const fullList = buildModel().workspaces[workspace.index()].windows;
    const list = fullList.filter(w => w !== window);

    let at = index === null ? list.length : index;
    at = Math.max(0, Math.min(at, list.length));

    list.splice(at, 0, window);

    for (const w of list) ranks.set(w, nextRank++);
}

// ==================== MODEL-OWNED SIGNALS ====================
// The model is the single place that knows *why* it changes. The UI listens
// to onIntentChange for transient flags and onWorldChange for rebuilds.

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

// The model subscribes to everything that invalidates it. `settings` is
// optional so unit tests / other consumers can drive it manually.
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
// Window lists for menus come from the model, not live Mutter reads.
// `workspace` may be null → all windows (already filtered & eligible).
export function getModelWindows(workspace = null) {
    const model = buildModel();
    if (workspace === null)
        return model.workspaces.flatMap(ws => ws.windows);
    const entry = model.workspaces.find(ws => ws.workspace === workspace);
    return entry ? entry.windows : [];
}

// ==================== SNAPSHOT / LOGGING ====================
// Takes the *already-built* model as an argument — never calls buildModel()
// itself, so logging cannot perturb the rank map mid-mutation. These are
// plain helpers: call them whenever you want a dump; there is no flag here.
export function getModelSnapshot(model) {
    return {
        drag: model.drag ? {
            windowTitle: model.drag.window?.get_title() || 'Unknown Window',
            target: model.drag.target,
        } : null,
        hintWs: model.hintWs,
        workspaces: model.workspaces.map(ws => ({
            index: ws.index,
            windowCount: ws.windows.length,
            windows: ws.windows.map(w => w.get_title() || 'Untitled'),
        })),
    };
}

export function logModel(model) {
    journal('[Model Snapshot]\n' + JSON.stringify(getModelSnapshot(model), null, 2));
}