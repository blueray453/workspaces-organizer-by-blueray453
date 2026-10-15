import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import { SearchOverlayBase, WindowSearchOverlay, AppSearchOverlay } from './searchOverlays.js';
import { buildModel, getModelWindows } from './model.js';
import { Display, WorkspaceManager } from './shellGlobals.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== OVERLAY SERVICE ====================
// The single place any search overlay is opened or closed, and the only
// place this extension talks to DBus. Only one overlay exists at a time
// (each pushes a full-screen modal grab), so every show closes whatever
// was open first. WindowSearchOverlay serves both "all windows" and "one
// workspace", so instances are tagged with `_overlayContext` for toggles.

const BUS_NAME = 'io.github.blueray453.TopNotchWorkspaces';
const BUS_PATH = '/io/github/blueray453/TopNotchWorkspaces/Overlay';

// dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.ShowWorkspaceWindows uint32:3

const MR_DBUS_IFACE = `
<node>
   <interface name="io.github.blueray453.TopNotchWorkspaces.Overlay">
      <method name="ShowAllWindows"/>
      <method name="ShowAllApps"/>
      <method name="ShowWorkspaceWindows">
         <arg type="u" direction="in" name="workspace_num"/>
      </method>
      <method name="ToggleAllWindows"/>
      <method name="ToggleAllApps"/>
      <method name="ToggleWorkspaceWindows">
         <arg type="u" direction="in" name="workspace_num"/>
      </method>
      <method name="CloseOverlay"/>
      <method name="CycleWindowsOnWorkspace">
         <arg type="u" direction="in" name="workspace_num"/>
      </method>
   </interface>
</node>`;

let _settings = null;
let _ownerId = 0;
let _exported = null;

// -------------------- Show / close --------------------
export function showWindowOverlay(windows, context = null, focusedWindow = null) {
    if (!_settings) {
        journal('[overlayService] showWindowOverlay before init — ignoring', true);
        return false;
    }
    SearchOverlayBase.closeCurrent();
    const overlay = new WindowSearchOverlay(windows, _settings, focusedWindow);
    overlay._overlayContext = context;
    return true;
}

export function showAllWindows() {
    return showWindowOverlay(
        getModelWindows(null),   // model order (user order)
        { type: 'all-windows' },
        Display.focus_window);
}

export function showAllApps() {
    if (!_settings) {
        journal('[overlayService] showAllApps before init — ignoring', true);
        return false;
    }
    SearchOverlayBase.closeCurrent();
    new AppSearchOverlay(_settings);
    return true;
}

export function toggleAllApps() {
    if (SearchOverlayBase.current instanceof AppSearchOverlay) {
        SearchOverlayBase.closeCurrent();
        return false;
    }
    return showAllApps();
}

export function toggleAllWindows() {
    const current = SearchOverlayBase.current;
    if (current instanceof WindowSearchOverlay && current._overlayContext?.type === 'all-windows') {
        SearchOverlayBase.closeCurrent();
        return false;
    }
    return showAllWindows();
}

// One workspace's windows, plus a workspace switch. Window list comes from
// the model (user order); "focused" comes from Mutter's own per-workspace
// MRU list, read BEFORE activating (workspace.activate() doesn't reliably
// refocus on its own).
export function showWorkspaceWindows(workspaceIndex) {
    const workspace = WorkspaceManager.get_workspace_by_index(workspaceIndex);
    if (!workspace)
        throw new Error(`Workspace ${workspaceIndex} not found`);

    const windows = buildModel().workspaces[workspaceIndex].windows;
    const focusedWindow = Display.get_tab_list(Meta.TabList.NORMAL, workspace)[0] ?? null;

    workspace.activate(global.get_current_time());
    const opened = showWindowOverlay(windows, { type: 'workspace', workspaceIndex }, focusedWindow);
    journal(`[overlayService] showWorkspaceWindows ${workspaceIndex} (${windows.length} windows)`);
    return opened;
}

// Only recognizes an overlay opened via showWorkspaceWindows() — one opened
// from the workspace's own overflow button is untagged on purpose... see
// showWorkspaceWindows: both paths now go through it, so both tag.
export function toggleWorkspaceWindows(workspaceIndex) {
    const current = SearchOverlayBase.current;
    if (current instanceof WindowSearchOverlay &&
        current._overlayContext?.type === 'workspace' &&
        current._overlayContext.workspaceIndex === workspaceIndex) {
        SearchOverlayBase.closeCurrent();
        return false;
    }
    return showWorkspaceWindows(workspaceIndex);
}

export function closeOverlay() { return SearchOverlayBase.closeCurrent(); }

// Focus the next window on `workspaceIndex` in the indicator's visual
// order. buildModel() returns windows in rank order, which is exactly what
// the user sees on the strip — including after a DnD rearrange, because a
// drop calls placeWindow() which rewrites the ranks.
//
// Step forwards, wrapping from the last window back to the first; if
// nothing is focused, start at the first window.
export function cycleWindowsOnWorkspace(workspaceIndex) {
    const model = buildModel();
    const entry = model.workspaces[workspaceIndex];
    if (!entry || entry.windows.length === 0) return;

    const windows = entry.windows;
    const focused = Display.focus_window;
    const idx = windows.indexOf(focused);

    const nextIdx = idx === -1
        ? 0
        : (idx + 1) % windows.length;
    const next = windows[nextIdx];

    if (next.minimized) next.unminimize();
    next.activate(global.get_current_time());
}

// -------------------- DBus --------------------
const dbusObject = {
    CloseOverlay() { closeOverlay(); },
    ShowAllApps() { showAllApps(); },
    ShowAllWindows() { showAllWindows(); },
    ShowWorkspaceWindows(n) { showWorkspaceWindows(n); },
    ToggleAllApps() { toggleAllApps(); },
    ToggleAllWindows() { toggleAllWindows(); },
    ToggleWorkspaceWindows(n) { toggleWorkspaceWindows(n); },
    CycleWindowsOnWorkspace(n) { cycleWindowsOnWorkspace(n); },
};

function _onBusAcquired(connection) {
    try {
        _exported = Gio.DBusExportedObject.wrapJSObject(MR_DBUS_IFACE, dbusObject);
        _exported.export(connection, BUS_PATH);
        journal(`[overlayService] Exported on ${BUS_PATH}`);
    } catch (e) {
        journal(`[overlayService] Failed to export: ${e.message}`, true);
    }
}

function _unexport() {
    if (!_exported) return;
    try { _exported.flush(); _exported.unexport(); } catch (e) { /* not exported */ }
    _exported = null;
}

// -------------------- Lifecycle --------------------
export function initOverlayService(settings) {
    _settings = settings;
    _ownerId = Gio.bus_own_name(
        Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
        connection => _onBusAcquired(connection),
        (connection, name) => journal(`[overlayService] ${name}: name acquired`),
        (connection, name) => { journal(`[overlayService] ${name}: name lost`, true); _unexport(); });
}

export function destroyOverlayService() {
    closeOverlay(); // never leave a modal grab behind
    _unexport();
    if (_ownerId) { Gio.bus_unown_name(_ownerId); _ownerId = 0; }
    _settings = null;
}