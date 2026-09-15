import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import { SearchOverlayBase } from './searchOverlayBase.js';
import { WindowSearchOverlay } from './windowSearchOverlay.js';
import { AppSearchOverlay } from './appSearchOverlay.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';

import { Display, WorkspaceManager } from './shellGlobals.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== OVERLAY SERVICE ====================
// The single place any search overlay is opened or closed, and the only
// place this extension talks to DBus. Every entry point — the two
// toolbar buttons, the "▱ N windows" overflow button, and the four DBus
// methods — funnels through the exported functions below, so the click
// path and the remote path can never drift apart.
//
// Only one overlay exists at a time (each pushes a full-screen modal
// grab), so every show closes whatever was already open first.

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
      <method name="ToggleAllApps"/>
      <method name="CloseOverlay"/>
   </interface>
</node>`;

let _settings = null;
let _ownerId = 0;
let _exported = null;

// -------------------- Show / close --------------------

// The shared primitive. WindowOverflowButton's click handler and the
// DBus paths both end up here.
export function showWindowOverlay(windows) {
    if (!_settings) {
        journal('[overlayService] showWindowOverlay before init — ignoring', true);
        return false;
    }
    SearchOverlayBase.closeCurrent();
    new WindowSearchOverlay(windows, _settings);
    return true;
}

// Every window on every workspace.
export function showAllWindows() {
    return showWindowOverlay(Display.get_tab_list(Meta.TabList.NORMAL, null));
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

// If the app overlay is the one currently open, close it. Otherwise —
// nothing open, or some OTHER overlay open — open it, closing whatever
// else was open first (same as showAllApps() already does on its own).
export function toggleAllApps() {                                        // ADD
    const current = SearchOverlayBase.current;
    if (current instanceof AppSearchOverlay) {
        SearchOverlayBase.closeCurrent();
        journal('[overlayService] toggleAllApps: was open — closed');
        return false;
    }
    const opened = showAllApps();
    journal(`[overlayService] toggleAllApps: ${opened ? 'opened' : 'failed to open (not initialized)'}`);
    return opened;
}

// One workspace's windows — what clicking its "▱ N windows" button does,
// plus a workspace switch. Prefers the thumbnail's own order (which
// reflects the user's drag-reordering); falls back to the tab list if no
// thumbnail exists for that workspace.
export function showWorkspaceWindows(workspaceIndex) {
    const workspace = WorkspaceManager.get_workspace_by_index(workspaceIndex);
    if (!workspace)
        throw new Error(`Workspace ${workspaceIndex} not found`);

    const thumbnail = WorkspaceThumbnailRegistry.getForWorkspace(workspace);
    const windows = thumbnail
        ? thumbnail.windows
        : Display.get_tab_list(Meta.TabList.NORMAL, workspace);

    workspace.activate(global.get_current_time());
    journal(`[overlayService] showWorkspaceWindows ${workspaceIndex} (${windows.length} windows, thumbnail=${thumbnail ? 'yes' : 'no'})`);
    return showWindowOverlay(windows);
}

export function closeOverlay() {
    return SearchOverlayBase.closeCurrent();
}

// -------------------- DBus --------------------

const dbusObject = {
    CloseOverlay() { closeOverlay(); },
    ShowAllApps() { showAllApps(); },
    ShowAllWindows() { showAllWindows(); },
    ShowWorkspaceWindows(workspaceNum) { showWorkspaceWindows(workspaceNum); },
    ToggleAllApps() { toggleAllApps(); },
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
    try {
        _exported.flush();
        _exported.unexport();
    } catch (e) {
        // Ignore "not exported" during cleanup
    }
    _exported = null;
}

// -------------------- Lifecycle --------------------

export function initOverlayService(settings) {
    _settings = settings;
    _ownerId = Gio.bus_own_name(
        Gio.BusType.SESSION,
        BUS_NAME,
        Gio.BusNameOwnerFlags.NONE,
        connection => _onBusAcquired(connection),
        (connection, name) => journal(`[overlayService] ${name}: name acquired`),
        (connection, name) => {
            journal(`[overlayService] ${name}: name lost`, true);
            _unexport();
        },
    );
}

export function destroyOverlayService() {
    // Never leave a modal grab behind on disable.
    closeOverlay();
    _unexport();
    if (_ownerId) {
        Gio.bus_unown_name(_ownerId);
        _ownerId = 0;
    }
    _settings = null;
}
