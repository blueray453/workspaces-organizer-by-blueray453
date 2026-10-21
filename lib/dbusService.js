// ===== FILE: ./lib/dbusService.js =====
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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
      <method name="Show">
         <arg type="as"          direction="in" name="items"/>
         <arg type="b"           direction="in" name="multi"/>
         <arg type="s"           direction="in" name="hint"/>
         <arg type="a(ssa(ss))"  direction="in" name="controls"/>
      </method>
      <signal name="Selected">
         <arg type="as" name="items"/>
      </signal>
      <signal name="Cancelled"/>
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
        TaggedWindows.toggleTagFocusedWindow();
    },
    CloseOtherNotMarkedWindowsCurrentWorkspaceOfFocusedWindowWMClass() {
        TaggedWindows.closeOtherNotTaggedCurrentWorkspaceWmClass();
    },
    // Dmenu-style picker. No return value: the answer arrives via the
    // Selected / Cancelled signals emitted from _emitResult below.
    // The caller MUST subscribe to both signals before invoking Show.
    // controls: [[kind, label, [[optLabel, optArg], ...]], ...]
    Show(items, multi, hint, controls) {
        const defs = (controls ?? [])
            .map(([kind, label, opts]) => ({
                kind, label,
                options: (opts ?? []).map(([l, a]) => ({ label: l, arg: a })),
            }))
            .filter(c => (c.kind === 'toggle' && c.options.length >= 1) ||
                (c.kind === 'choice' && c.options.length >= 2));

        const opened = OverlayService.showDmenuItems(
            items ?? [],
            { multi: !!multi, hint: hint || null, controls: defs },
            result => _emitResult(result));
        // If the overlay could not open (extension still initialising,
        // no primary monitor, etc.), emit Cancelled so the caller doesn't hang.
        if (!opened) _emitResult(null);
    },
};

let _ownerId = 0;
let _exported = null;

function _emitResult(result) {
    if (!_exported) return;
    if (Array.isArray(result) && result.length > 0)
        _exported.emit_signal('Selected', GLib.Variant.new('(as)', [result]));
    else
        _exported.emit_signal('Cancelled', null);
}

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

// ==================== CLI HELPERS ====================
// Symlinks installed into ~/.local/bin on enable(), removed on disable().
//   gdmenu         — Dmenu/rofi-style picker client (Show/Selected/Cancelled)
//   topnotch-call  — Method-call client for every other Overlay method
const CLIS = [
    { name: 'gdmenu', path: ['cli', 'gdmenu'] },
    { name: 'topnotch-call', path: ['cli', 'topnotch-call'] },
];

export function installCli(extensionPath) {
    for (const cli of CLIS) _installOneCli(extensionPath, cli);
}

export function removeCli(extensionPath) {
    for (const cli of CLIS) _removeOneCli(extensionPath, cli);
}

function _installOneCli(extensionPath, { name, path }) {
    const cliScript = GLib.build_filenamev([extensionPath, ...path]);
    const binDir = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin']);
    const symlinkPath = GLib.build_filenamev([binDir, name]);

    try {
        GLib.chmod(cliScript, 0o755);
        GLib.mkdir_with_parents(binDir, 0o755);

        const linkFile = Gio.File.new_for_path(symlinkPath);
        if (linkFile.query_exists(null)) {
            const info = linkFile.query_info(
                Gio.FILE_ATTRIBUTE_STANDARD_SYMLINK_TARGET,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            if (info.get_symlink_target() === cliScript) return;
            linkFile.delete(null);
        }
        linkFile.make_symbolic_link(cliScript, null);
        journal(`[dbusService] CLI symlinked: ${symlinkPath}`);
    } catch (e) {
        journal(`[dbusService] CLI install failed (${name}): ${e.message}`, true);
    }
}

function _removeOneCli(extensionPath, { name, path }) {
    const cliScript = GLib.build_filenamev([extensionPath, ...path]);
    const symlinkPath = GLib.build_filenamev([
        GLib.get_home_dir(), '.local', 'bin', name]);

    try {
        const linkFile = Gio.File.new_for_path(symlinkPath);
        if (!linkFile.query_exists(null)) return;
        const info = linkFile.query_info(
            Gio.FILE_ATTRIBUTE_STANDARD_SYMLINK_TARGET,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_symlink_target() === cliScript) {
            linkFile.delete(null);
            journal(`[dbusService] CLI symlink removed: ${name}`);
        }
    } catch (e) {
        journal(`[dbusService] CLI remove failed (${name}): ${e.message}`, true);
    }
}