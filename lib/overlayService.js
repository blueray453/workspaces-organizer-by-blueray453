import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import { SearchOverlayBase } from './searchOverlayBase.js';
import { WindowSearchOverlay } from './windowSearchOverlay.js';
import { AppSearchOverlay } from './appSearchOverlay.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';
import { FocusHistory } from './focusHistory.js';

import { Display, WorkspaceManager } from './shellGlobals.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== OVERLAY SERVICE ====================
// The single place any search overlay is opened or closed, and the only
// place this extension talks to DBus. Every entry point — the two
// toolbar buttons, the "▱ N windows" overflow button, and the seven DBus
// methods — funnels through the exported functions below, so the click
// path and the remote path can never drift apart.
//
// Only one overlay exists at a time (each pushes a full-screen modal
// grab), so every show closes whatever was already open first.
//
// WindowSearchOverlay is the SAME class for both "all windows" and "one
// workspace's windows" — a bare instanceof check can't tell them apart.
// showWindowOverlay() tags each instance with a small `_overlayContext`
// object so toggleAllWindows()/toggleWorkspaceWindows() can recognize
// "is THIS specific overlay already open" rather than just "is some
// window overlay open".

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
   </interface>
</node>`;

let _settings = null;
let _ownerId = 0;
let _exported = null;

// -------------------- Show / close --------------------

// The shared primitive. WindowOverflowButton's click handler and both
// window-overlay show/toggle paths below end up here. `context` tags the
// created overlay for the toggle functions to recognize later; pass null
// when the caller (e.g. the overflow button) doesn't need toggle support.
// `focusedWindow`, if given, is which window should be shown as
// "currently focused" in the results list — see WindowSearchOverlay.
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

// Every window on every workspace. No workspace switch happens here, so
// the live focus-window is always meaningful.
export function showAllWindows() {
    return showWindowOverlay(
        Display.get_tab_list(Meta.TabList.NORMAL, null),
        { type: 'all-windows' },
        Display.focus_window,
    );
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
export function toggleAllApps() {
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

// Same pattern as toggleAllApps(), but for the "all windows on all
// workspaces" overlay. Distinguished from a workspace-scoped overlay via
// _overlayContext.type, since both use the WindowSearchOverlay class.
export function toggleAllWindows() {
    const current = SearchOverlayBase.current;
    if (current instanceof WindowSearchOverlay && current._overlayContext?.type === 'all-windows') {
        SearchOverlayBase.closeCurrent();
        journal('[overlayService] toggleAllWindows: was open — closed');
        return false;
    }
    const opened = showAllWindows();
    journal(`[overlayService] toggleAllWindows: ${opened ? 'opened' : 'failed to open (not initialized)'}`);
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

    // workspace.activate() does NOT reliably refocus that workspace's
    // last-used window on its own (see FocusHistory's comment) — so we
    // can't just read Display.focus_window after switching and expect
    // it to be correct. Look up our own record of what was last focused
    // on this workspace instead.
    const focusedWindow = FocusHistory.getFocusedWindow(workspace);

    workspace.activate(global.get_current_time());

    const opened = showWindowOverlay(windows, { type: 'workspace', workspaceIndex }, focusedWindow);

    journal(`[overlayService] showWorkspaceWindows ${workspaceIndex} (${windows.length} windows, thumbnail=${thumbnail ? 'yes' : 'no'}, focusedWindow=${focusedWindow?.title ?? 'none'})`);
    return opened;
}

// Note: only recognizes an overlay opened via showWorkspaceWindows()/
// this toggle as "already open for workspace N" — a WindowSearchOverlay
// opened by clicking that workspace's own overflow button is untagged
// (context null) and won't match, so toggling reopens it fresh
// (including the workspace-switch showWorkspaceWindows does) rather than
// closing it. That reflects a real difference: the button's overlay
// never switched workspace in the first place, this one does.
export function toggleWorkspaceWindows(workspaceIndex) {
    const current = SearchOverlayBase.current;
    if (current instanceof WindowSearchOverlay &&
        current._overlayContext?.type === 'workspace' &&
        current._overlayContext.workspaceIndex === workspaceIndex) {
        SearchOverlayBase.closeCurrent();
        journal(`[overlayService] toggleWorkspaceWindows: workspace ${workspaceIndex} was open — closed`);
        return false;
    }
    const opened = showWorkspaceWindows(workspaceIndex); // propagates "workspace not found"
    journal(`[overlayService] toggleWorkspaceWindows: workspace ${workspaceIndex} ${opened ? 'opened' : 'failed to open (not initialized)'}`);
    return opened;
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
    ToggleAllWindows() { toggleAllWindows(); },
    ToggleWorkspaceWindows(workspaceNum) { toggleWorkspaceWindows(workspaceNum); },
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
    FocusHistory.init();
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
    FocusHistory.destroy();
    _settings = null;
}