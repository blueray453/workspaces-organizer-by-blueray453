// ===== FILE: ./lib/model.js =====
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Store, Emitter, Hold } from './util.js';
import { configureMotion } from './motion.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

export const WorkspaceManager = global.get_workspace_manager();
export const Display = global.get_display();

export const TimeoutDelay = 200;

export function applySettings(settings) {
    if (!settings) return;
    configureMotion({ reduceMotion: settings.get_boolean('reduce-motion') });
}

// ---- intent ----
export const intentStore = new Store({
    drag: null, hintWs: null, menuOpen: false,
    overlayPick: null,
    // Persisted across overlay opens in the same session.
    // Reset on extension reload. See windowOverlay.js for shape.
    overlayFilters: {
        workspace: null,   // null | workspace index
        app: null,         // null | app id
        pinnedOnly: false, // bool
    },
});
export const intent = intentStore.state;
export const world = new Emitter();
export const requestRender = () => world.emit();
export const resetIntent = () => intentStore.reset();
export const setIntent = patch => intentStore.patch(patch);
export const menuIntent = open => setIntent({ menuOpen: open });

// ---- eligibility ----
function isEligible(w) {
    if (!w) return false;
    if (w.skip_taskbar || w.is_override_redirect()) return false;
    const t = w.get_window_type();
    return t === Meta.WindowType.NORMAL
        || t === Meta.WindowType.DIALOG
        || t === Meta.WindowType.MODAL_DIALOG
        || t === Meta.WindowType.UTILITY;
}

export function isNormalWindow(win) {
    return win?.get_window_type() === Meta.WindowType.NORMAL;
}

export function focusedWindow() {
    return isEligible(Display.focus_window) ? Display.focus_window : null;
}

// ---- ordering ----
const ranks = new Map();
let nextRank = 1;

// ---- last-focused-per-workspace ----
const lastFocusedByWs = new Map();

// ---- focus history suppression ----
const focusHold = new Hold();
export function holdFocusHistory() { return focusHold.acquire(); }

export function noteFocusedWindow() {
    if (focusHold.active) return;
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

// ---- app identity / grouping ----
export function appIdentity(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    if (app) {
        const id = app.get_id();
        if (id) return { id, name: app.get_name() || id };
    }
    const wm = window.get_wm_class() || window.get_wm_class_instance() || 'unknown';
    return { id: `wm:${wm}`, name: wm };
}

export function groupKey(workspaceIndex, appId, anchorId = '') {
    return `${workspaceIndex}::${appId}${anchorId !== '' ? `#${anchorId}` : ''}`;
}

export function groupWindowsInWorkspace(entry) {
    const out = [];
    let cur = null;
    entry.windows.forEach((w, i) => {
        const { id, name } = appIdentity(w);
        if (!cur || cur.appId !== id) {
            cur = {
                appId: id, appName: name,
                key: groupKey(entry.index, id, w.get_id()),
                windows: [], indices: [], count: 0,
            };
            out.push(cur);
        }
        cur.windows.push(w);
        cur.indices.push(i);
        cur.count++;
    });
    return out;
}

// ---- build ----
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
        };
        entry.groups = groupWindowsInWorkspace(entry);
        workspaces.push(entry);
    }
    return { workspaces, drag: intent.drag, hintWs: intent.hintWs };
}

export function placeWindow(window, workspace, index = null) {
    const fullList = buildModel().workspaces[workspace.index()].windows;
    const list = fullList.filter(w => w !== window);

    let at = index === null ? list.length : index;
    at = Math.max(0, Math.min(at, list.length));

    list.splice(at, 0, window);

    for (const w of list) ranks.set(w, nextRank++);
}

export function placeWindowNear(window, workspace, neighbor = null, before = true) {
    if (neighbor === window) return;
    const list = buildModel().workspaces[workspace.index()].windows
        .filter(w => w !== window);

    let at = list.length;
    if (neighbor) {
        const i = list.indexOf(neighbor);
        if (i >= 0) at = before ? i : i + 1;
    }
    list.splice(at, 0, window);
    for (const w of list) ranks.set(w, nextRank++);
}

// ---- signals ----
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

export function getModelSnapshot(model) {
    return {
        drag: !!model.drag,
        hintWs: model.hintWs,
        workspaces: model.workspaces.map(ws => ({
            index: ws.index,
            windowCount: ws.windows.length,
            groups: ws.groups.map(g => `${g.appName}:${g.count}`),
        })),
    };
}

export function logModel(model) {
    journal('[Model Snapshot]\n' + JSON.stringify(getModelSnapshot(model), null, 2));
}