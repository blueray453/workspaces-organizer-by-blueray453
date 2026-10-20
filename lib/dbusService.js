// ===== FILE: ./lib/dbusService.js =====
import Gio from 'gi://Gio';

import * as OverlayService from './overlayService.js';
import * as WorkspaceActions from './workspaceActions.js';
import * as WorkspaceIndicatorModule from './workspaceIndicator.js';

import * as TaggedWindows from './taggedWindows.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== DBUS TRANSPORT ====================

const BUS_NAME = 'io.github.blueray453.TopNotchWorkspaces';
const BUS_PATH = '/io/github/blueray453/TopNotchWorkspaces/Overlay';

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
      <method name="ToggleGroupFlyout">
         <arg type="u" direction="in" name="workspace_num"/>
         <arg type="s" direction="in" name="wm_class"/>
         <arg type="b" direction="out" name="opened"/>
      </method>
      <method name="CloseFlyout">
         <arg type="b" direction="out" name="was_open"/>
      </method>
      <method name="ToggleMarksFocusedWindow"/>
      <method name="CloseOtherNotMarkedWindowsCurrentWorkspaceOfFocusedWindowWMClass"/>
   </interface>
</node>`;

const dbusObject = {
    CloseOverlay() { OverlayService.closeOverlay(); },
    ShowAllApps() { OverlayService.showAllApps(); },
    ShowAllWindows() { OverlayService.showAllWindows(); },
    ShowWorkspaceWindows(n) { OverlayService.showWorkspaceWindows(n); },
    ToggleAllApps() { OverlayService.toggleAllApps(); },
    ToggleAllWindows() { OverlayService.toggleAllWindows(); },
    ToggleWorkspaceWindows(n) { OverlayService.toggleWorkspaceWindows(n); },
    CycleWindowsOnWorkspace(n) { WorkspaceActions.cycleWindowsOnWorkspace(n, 1); },

    ToggleGroupFlyout(workspaceNum, wmClass) {
        return WorkspaceIndicatorModule.toggleGroupFlyout(workspaceNum, wmClass ?? '');
    },
    CloseFlyout() {
        return WorkspaceIndicatorModule.closeGroupFlyout();
    },
    ToggleMarksFocusedWindow() {
        TaggedWindows.toggleMarksFocusedWindow();
    },
    CloseOtherNotMarkedWindowsCurrentWorkspaceOfFocusedWindowWMClass() {
        TaggedWindows.closeOtherNotMarkedCurrentWorkspaceWmClass();
    },
};

let _ownerId = 0;
let _exported = null;

function _onBusAcquired(connection) {
    try {
        _exported = Gio.DBusExportedObject.wrapJSObject(MR_DBUS_IFACE, dbusObject);
        _exported.export(connection, BUS_PATH);
        journal(`[dbusService] Exported on ${BUS_PATH}`);
    } catch (e) {
        journal(`[dbusService] Failed to export: ${e.message}`, true);
    }
}

function _unexport() {
    if (!_exported) return;
    try { _exported.flush(); _exported.unexport(); } catch (e) { /* not exported */ }
    _exported = null;
}

export function initDBusService() {
    _ownerId = Gio.bus_own_name(
        Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
        connection => _onBusAcquired(connection),
        (connection, name) => journal(`[dbusService] ${name}: name acquired`),
        (connection, name) => { journal(`[dbusService] ${name}: name lost`, true); _unexport(); });
}

export function destroyDBusService() {
    _unexport();
    if (_ownerId) { Gio.bus_unown_name(_ownerId); _ownerId = 0; }
}