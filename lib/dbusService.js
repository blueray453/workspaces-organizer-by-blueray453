import Gio from 'gi://Gio';

import * as service from './overlayService.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== DBUS TRANSPORT ====================
// The bus name, object path, interface XML, and the exported adapter object.
// This is the extension's whole external control surface — overlay methods
// and workspace operations (CycleWindowsOnWorkspace) alike. Nothing about
// the underlying logic lives here; every method is a one-line forward to
// overlayService (or, for workspace ops, to the same module's cycle helper).

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
   </interface>
</node>`;

const dbusObject = {
    CloseOverlay() { service.closeOverlay(); },
    ShowAllApps() { service.showAllApps(); },
    ShowAllWindows() { service.showAllWindows(); },
    ShowWorkspaceWindows(n) { service.showWorkspaceWindows(n); },
    ToggleAllApps() { service.toggleAllApps(); },
    ToggleAllWindows() { service.toggleAllWindows(); },
    ToggleWorkspaceWindows(n) { service.toggleWorkspaceWindows(n); },
    CycleWindowsOnWorkspace(n) { service.cycleWindowsOnWorkspace(n); },
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