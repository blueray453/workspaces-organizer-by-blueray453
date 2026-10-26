// ===== FILE: ./lib/model.js =====
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

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

// Narrower than isEligible — exactly NORMAL | DIALOG, matching the filter
// used by getNormalWindows() in windowFunctions.js (the CLI/DBus surface).
export function isTabWindow(win) {
    const t = win?.get_window_type();
    return t === Meta.WindowType.NORMAL || t === Meta.WindowType.DIALOG;
}

// The single place the extension checks for the file-progress marker window
// (used by interactions.js, selectedWindows.js, windowFunctions.js).
export function isFileProgress(win) {
    return win?.get_wm_class_instance() === 'file_progress';
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

export function groupKey(workspaceIndex, appId) {
    return `${workspaceIndex}::${appId}`;
}

// One group per app per workspace. Windows inside a group stay in MRU order
// (entry.windows is MRU). Groups are ordered by favorites, then oldest window id.
export function groupWindowsInWorkspace(entry) {
    const favIds = AppFavorites.getAppFavorites().getFavorites().map(a => a.get_id());
    const byApp = new Map();

    entry.windows.forEach((w, i) => {
        // Dialogs ride with their parent's app.
        const { id, name } = appIdentity(w.get_transient_for() ?? w);
        let g = byApp.get(id);
        if (!g) {
            g = {
                appId: id, appName: name, key: groupKey(entry.index, id),
                windows: [], indices: [], count: 0,
            };
            byApp.set(id, g);
        }
        g.windows.push(w);
        g.indices.push(i);
        g.count++;
    });

    const oldest = g => Math.min(...g.windows.map(w => w.get_id()));
    const rank = g => { const f = favIds.indexOf(g.appId); return f < 0 ? Infinity : f; };

    return [...byApp.values()].sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra < rb ? -1 : 1;
        return oldest(a) - oldest(b);
    });
}

// ---- MRU ----
// One global list. Every per-workspace list, the overlay, panel scroll
// and per-workspace cycling all derive from this, so they cannot disagree.
export function mruWindows() {
    return Display.get_tab_list(Meta.TabList.NORMAL_ALL, null).filter(isEligible);
}

// ---- build ----
export function buildModel() {
    const mru = mruWindows();
    const workspaces = [];
    for (let i = 0; i < WorkspaceManager.n_workspaces; i++) {
        const workspace = WorkspaceManager.get_workspace_by_index(i);
        const windows = mru.filter(w => w.located_on_workspace(workspace));
        const entry = { workspace, index: i, windows };
        entry.groups = groupWindowsInWorkspace(entry);
        workspaces.push(entry);
    }
    return { workspaces, drag: intent.drag, hintWs: intent.hintWs };
}

// Layout signature: which windows are in which group, in group order.
// Deliberately independent of MRU order.
export function signatureOf(model) {
    return model.workspaces.map(ws =>
        ws.groups.map(g =>
            `${g.key}:${g.windows.map(w => w.get_id()).sort((a, b) => a - b).join('.')}`
        ).join(',')).join('|');
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
        _listen(settings, 'changed', (_s, key) => {
            if (key.startsWith('discovered-')) return;
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
    const mru = mruWindows();
    return workspace === null ? mru : mru.filter(w => w.located_on_workspace(workspace));
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

// Convenience lookup used by keybindingFunctions.js and the CLI adapters.
export function getWindowById(id) {
    return Display.list_all_windows().find(w => w.get_id() === id) ?? null;
}