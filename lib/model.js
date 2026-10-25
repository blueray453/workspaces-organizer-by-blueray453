import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Store, Emitter } from './util.js';
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
    overlayFilters: {
        workspace: null,
        app: null,
        pinnedOnly: false,
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

// ---- manual-order overlay ----
// wsIndex -> ordered Meta.Window[] snapshot. Written ONLY on explicit
// drag-drops (placeWindow / placeWindowNear). Windows not in the snapshot
// fall back to MRU position.
const manualOrder = new Map();

export function setManualOrder(workspaceIndex, orderedWindows) {
    if (!orderedWindows?.length) manualOrder.delete(workspaceIndex);
    else manualOrder.set(workspaceIndex, [...orderedWindows]);
}

export function clearManualOrder(workspaceIndex) {
    manualOrder.delete(workspaceIndex);
}

// ---- ordering ----
function mruListFor(workspace) {
    const list = Display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace ?? null);
    return workspace ? list.filter(w => w.located_on_workspace(workspace)) : list;
}

function applyManual(wsIndex, mru) {
    const manual = manualOrder.get(wsIndex);
    if (!manual || !manual.length) return mru;

    const live = new Set(mru);
    const surviving = manual.filter(w => live.has(w));
    const inOrder = new Set(surviving);
    const newOnes = mru.filter(w => !inOrder.has(w));

    // D1 = (i): manual positions stay put; new windows flow in after them.
    // For D1 = (ii), change to: return [...newOnes, ...surviving];
    return [...surviving, ...newOnes];
}

// ---- build ----
export function buildModel() {
    const workspaces = [];
    for (let i = 0; i < WorkspaceManager.n_workspaces; i++) {
        const workspace = WorkspaceManager.get_workspace_by_index(i);
        const mru = mruListFor(workspace).filter(isEligible);
        const ordered = applyManual(i, mru);
        const entry = { workspace, index: i, windows: ordered };
        entry.groups = groupWindowsInWorkspace(entry);
        workspaces.push(entry);
    }
    return { workspaces, drag: intent.drag, hintWs: intent.hintWs };
}

// ---- drops (write manual overlay) ----
export function placeWindow(window, workspace, index = null) {
    const wsIndex = workspace.index();
    const current = buildModel().workspaces[wsIndex].windows;
    const list = current.filter(w => w !== window);
    const at = index === null ? list.length : Math.max(0, Math.min(index, list.length));
    list.splice(at, 0, window);
    setManualOrder(wsIndex, list);
}

export function placeWindowNear(window, workspace, neighbor = null, before = true) {
    if (neighbor === window) return;
    const wsIndex = workspace.index();
    const current = buildModel().workspaces[wsIndex].windows.filter(w => w !== window);
    let at = current.length;
    if (neighbor) {
        const i = current.indexOf(neighbor);
        if (i >= 0) at = before ? i : i + 1;
    }
    current.splice(at, 0, window);
    setManualOrder(wsIndex, current);
}

// ---- signals ----
let _signals = [];
let _wsSignals = [];
let _settings = null;

function _listen(obj, signal, cb) { _signals.push([obj, obj.connect(signal, cb)]); }

function _watchWorkspaces() {
    for (const [obj, id] of _wsSignals) {
        try { obj.disconnect(id); } catch (e) { /* gone */ }
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
    _listen(Main.sessionMode, 'updated', () => requestRender());
    if (settings) {
        _listen(settings, 'changed', () => {
            applySettings(settings);
            requestRender();
        });
    }

    _watchWorkspaces();
}

export function disconnectModelSignals() {
    for (const [obj, id] of _wsSignals) { try { obj.disconnect(id); } catch (e) { /* gone */ } }
    for (const [obj, id] of _signals) { try { obj.disconnect(id); } catch (e) { /* gone */ } }
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