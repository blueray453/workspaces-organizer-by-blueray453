// ===== FILE: ./lib/dbusService.js =====
//
// Single file handles every D-Bus surface exposed by the extension.
// One bus name (`io.github.blueray453.TopNotchWorkspaces`), five interfaces,
// one spec cache (`~/.cache/gnome-dbus-spec/topnotch.json`).
//
// Two comment lines above every handler:
//   // dbus-send --print-reply=literal --session --dest=… /path iface.Method <typed-args>
//   // topnotch-call Method <untyped-args>
//
// Argument syntax:
//   dbus-send:      uint32:44129093  |  string:"VSCodium"  |  array:string:"A","B","C"  |  boolean:true
//   topnotch-call:  44129093         |  "VSCodium"        |  "A,B,C"                  |  true
//
// Return-value methods that emit JSON end with `| jq .` in both examples.
// Void methods have no pipe. Methods that answer via signals (only `Show`)
// use the gdmenu CLI instead — noted inline.
//
// XML lives here, not in the modules. The moved modules (windowFunctions.js,
// workspaceFunctions.js, keyboardSimulatorFunctions.js, keybindingFunctions.js)
// are plain function libraries with no D-Bus code.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as OverlayService from './overlayService.js';
import * as WorkspaceActions from './workspaceActions.js';
import * as WorkspaceIndicatorModule from './workspaceIndicator.js';
import * as SelectedWindows from './selectedWindows.js';

import * as WF from './windowFunctions.js';
import * as WSF from './workspaceFunctions.js';
import * as KSF from './keyboardSimulatorFunctions.js';
import * as KBF from './keybindingFunctions.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const BUS_NAME = 'io.github.blueray453.TopNotchWorkspaces';
const BUS_PATH = '/io/github/blueray453/TopNotchWorkspaces';

const SPEC_CACHE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.cache', 'gnome-dbus-spec']);
const SPEC_CACHE_FILE = 'topnotch.json';

// ==================== Overlay interface ====================

const OVERLAY_XML = `
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
      <method name="ToggleSelectedWindow"/>
      <method name="CloseNotSelectedWindows"/>
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

function _emitOverlayResult(result) {
    const entry = state.exported.get('io.github.blueray453.TopNotchWorkspaces.Overlay');
    if (!entry) return;
    const { exported } = entry;
    if (Array.isArray(result) && result.length > 0)
        exported.emit_signal('Selected', GLib.Variant.new('(as)', [result]));
    else
        exported.emit_signal('Cancelled', null);
}

const OVERLAY_HANDLERS = {
    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.CloseOverlay
    // topnotch-call CloseOverlay
    CloseOverlay: () => OverlayService.closeOverlay(),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.ShowAllApps
    // topnotch-call ShowAllApps
    ShowAllApps: () => OverlayService.showAllApps(),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.ShowAllWindows
    // topnotch-call ShowAllWindows
    ShowAllWindows: () => OverlayService.showAllWindows(),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.ShowWorkspaceWindows uint32:3
    // topnotch-call ShowWorkspaceWindows 3
    ShowWorkspaceWindows: (n) => OverlayService.showWorkspaceWindows(n),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.ToggleAllApps
    // topnotch-call ToggleAllApps
    ToggleAllApps: () => OverlayService.toggleAllApps(),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.ToggleAllWindows
    // topnotch-call ToggleAllWindows
    ToggleAllWindows: () => OverlayService.toggleAllWindows(),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.ToggleWorkspaceWindows uint32:3
    // topnotch-call ToggleWorkspaceWindows 3
    ToggleWorkspaceWindows: (n) => OverlayService.toggleWorkspaceWindows(n),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.CycleWindowsOnWorkspace uint32:3
    // topnotch-call CycleWindowsOnWorkspace 3
    CycleWindowsOnWorkspace: (n) => WorkspaceActions.cycleWindowsOnWorkspace(n, 1),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.ToggleGroupFlyout uint32:2 string:"VSCodium"
    // topnotch-call ToggleGroupFlyout 2 "VSCodium"
    ToggleGroupFlyout: (workspaceNum, wmClass) =>
        WorkspaceIndicatorModule.toggleGroupFlyout(workspaceNum, wmClass ?? ''),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.CloseFlyout
    // topnotch-call CloseFlyout
    CloseFlyout: () => WorkspaceIndicatorModule.closeGroupFlyout(),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.ToggleSelectedWindow
    // topnotch-call ToggleSelectedWindow
    ToggleSelectedWindow: () => SelectedWindows.toggleSelectedWindow(),

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Overlay io.github.blueray453.TopNotchWorkspaces.Overlay.CloseNotSelectedWindows
    // topnotch-call CloseNotSelectedWindows
    CloseNotSelectedWindows: () => SelectedWindows.closeNotSelectedWindows(),

    // Show answers via the Selected / Cancelled signals — cannot be reached
    // by a sync proxy. Use the gdmenu CLI:
    //   printf 'one\ntwo\n' | gdmenu --multi
    Show: (items, multi, hint, controls) => {
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
            result => _emitOverlayResult(result));
        if (!opened) _emitOverlayResult(null);
    },
};

// ==================== Windows interface ====================
// All handler bodies live in ./windowFunctions.js as plain functions.
// This file owns only the XML and the wrapper.

const WINDOWS_XML = `
<node>
   <interface name="io.github.blueray453.TopNotchWorkspaces.Windows">
      <method name="CloseOtherWindowsCurrentWorkspaceOfFocusedWindowWMClass"/>
      <method name="GetAppFocusedWindow">
         <arg type="s" direction="out" name="app"/>
      </method>
      <method name="GetAppGivenAppID">
         <arg type="s" direction="in" name="app_id"/>
         <arg type="s" direction="out" name="app"/>
      </method>
      <method name="GetAppGivenPID">
         <arg type="u" direction="in" name="pid"/>
         <arg type="s" direction="out" name="app"/>
      </method>
      <method name="GetAppGivenWindowID">
         <arg type="u" direction="in" name="win_id"/>
         <arg type="s" direction="out" name="icon"/>
      </method>
      <method name="GetAppGivenWMClass">
         <arg type="s" direction="in" name="wm_class"/>
         <arg type="s" direction="out" name="windows"/>
      </method>
      <method name="GetAppsRunning">
         <arg type="s" direction="out" name="app"/>
      </method>
      <method name="GetAppsRunningGivenWMClass">
         <arg type="s" direction="in" name="wm_class"/>
         <arg type="s" direction="out" name="is_running"/>
      </method>
      <method name="GetWindowFocused">
         <arg type="s" direction="out" name="win"/>
      </method>
      <method name="GetWindowGivenWindowID">
         <arg type="u" direction="in" name="win_id"/>
         <arg type="s" direction="out" name="win"/>
      </method>
      <method name="GetWindows">
         <arg type="s" direction="out" name="win"/>
      </method>
      <method name="GetWindowCountCurrentWorkspace">
         <arg type="s" direction="out" name="count"/>
      </method>
      <method name="GetWindowCountGivenWorkspace">
         <arg type="u" direction="in" name="workspace_num"/>
         <arg type="s" direction="out" name="count"/>
      </method>
      <method name="GetWindowsCurrentWorkspace">
         <arg type="s" direction="out" name="win"/>
      </method>
      <method name="GetWindowsCurrentWorkspaceCurrentMonitor">
         <arg type="s" direction="out" name="win"/>
      </method>
      <method name="GetWindowsCurrentWorkspaceOfFocusedWindowWMClass">
         <arg type="s" direction="out" name="win"/>
      </method>
      <method name="ToggleWindowsCurrentWorkspace"/>
      <method name="GetWindowsExcludingGivenWMClass">
         <arg type="as" direction="in" name="wm_classes"/>
         <arg type="s" direction="out" name="win"/>
      </method>
      <method name="GetWindowsGivenWMClass">
         <arg type="s" direction="in" name="wm_class"/>
         <arg type="s" direction="out" name="wins"/>
      </method>
      <method name="ToggleLookingGlass"/>
      <method name="MinimizeOtherWindowsOfFocusedWindowWMClass"/>
      <method name="WindowActivateGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
      </method>
      <method name="WindowCloseGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
      </method>
      <method name="WindowFullScreenGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
      </method>
      <method name="WindowMaximizeGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
      </method>
      <method name="WindowMinimizeGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
      </method>
      <method name="WindowMoveGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
         <arg type="u" direction="in" name="x"/>
         <arg type="u" direction="in" name="y"/>
      </method>
      <method name="WindowMoveResizeGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
         <arg type="u" direction="in" name="x"/>
         <arg type="u" direction="in" name="y"/>
         <arg type="u" direction="in" name="width"/>
         <arg type="u" direction="in" name="height"/>
      </method>
      <method name="WindowMoveToCurrentWorkspace">
         <arg type="u" direction="in" name="win_id"/>
      </method>
      <method name="WindowMoveToExcludingGivenWMClasses">
         <arg type="as" direction="in" name="wm_classes"/>
         <arg type="u" direction="in" name="workspace_num"/>
      </method>
      <method name="WindowMoveToGivenWorkspaceGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
         <arg type="u" direction="in" name="workspace_num"/>
      </method>
      <method name="WindowRaiseGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
      </method>
      <method name="WindowResizeGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
         <arg type="u" direction="in" name="width"/>
         <arg type="u" direction="in" name="height"/>
      </method>
      <method name="WindowsActivateGivenWMClass">
         <arg type="s" direction="in" name="wm_class"/>
      </method>
      <method name="WindowsCloseDuplicateNemo"/>
      <method name="WindowsMoveToGivenWorkspaceGivenWMClass">
         <arg type="s" direction="in" name="wm_class"/>
         <arg type="u" direction="in" name="workspace_num"/>
      </method>
      <method name="WindowUnminimizeGivenWinID">
         <arg type="u" direction="in" name="win_id"/>
      </method>
   </interface>
</node>`;

const WINDOWS_HANDLERS = {
    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.CloseOtherWindowsCurrentWorkspaceOfFocusedWindowWMClass
    // topnotch-call CloseOtherWindowsCurrentWorkspaceOfFocusedWindowWMClass
    CloseOtherWindowsCurrentWorkspaceOfFocusedWindowWMClass: WF.CloseOtherWindowsCurrentWorkspaceOfFocusedWindowWMClass,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetAppFocusedWindow | jq .
    // topnotch-call GetAppFocusedWindow | jq .
    GetAppFocusedWindow: WF.GetAppFocusedWindow,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetAppGivenAppID string:"io.github.cboxdoerfer.FSearch.desktop" | jq .
    // topnotch-call GetAppGivenAppID "io.github.cboxdoerfer.FSearch.desktop" | jq .
    GetAppGivenAppID: WF.GetAppGivenAppID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetAppGivenPID uint32:3931313482 | jq .
    // topnotch-call GetAppGivenPID 3931313482 | jq .
    GetAppGivenPID: WF.GetAppGivenPID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetAppGivenWindowID uint32:44129093 | jq .
    // topnotch-call GetAppGivenWindowID 44129093 | jq .
    GetAppGivenWindowID: WF.GetAppGivenWindowID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetAppGivenWMClass string:"firefox-esr" | jq .
    // topnotch-call GetAppGivenWMClass "firefox-esr" | jq .
    GetAppGivenWMClass: WF.GetAppGivenWMClass,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetAppsRunning | jq .
    // topnotch-call GetAppsRunning | jq .
    GetAppsRunning: WF.GetAppsRunning,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetAppsRunningGivenWMClass string:"firefox-esr"
    // topnotch-call GetAppsRunningGivenWMClass "firefox-esr"
    GetAppsRunningGivenWMClass: WF.GetAppsRunningGivenWMClass,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetWindowFocused | jq -r '.[].id'
    // topnotch-call GetWindowFocused | jq -r '.id'
    GetWindowFocused: WF.GetWindowFocused,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetWindowGivenWindowID uint32:44129093 | jq .
    // topnotch-call GetWindowGivenWindowID 44129093 | jq .
    GetWindowGivenWindowID: WF.GetWindowGivenWindowID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetWindows | jq .
    // topnotch-call GetWindows | jq .
    GetWindows: WF.GetWindows,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetWindowCountCurrentWorkspace
    // topnotch-call GetWindowCountCurrentWorkspace
    GetWindowCountCurrentWorkspace: WF.GetWindowCountCurrentWorkspace,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetWindowCountGivenWorkspace uint32:0
    // topnotch-call GetWindowCountGivenWorkspace 0
    GetWindowCountGivenWorkspace: WF.GetWindowCountGivenWorkspace,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetWindowsCurrentWorkspace | jq .
    // topnotch-call GetWindowsCurrentWorkspace | jq .
    GetWindowsCurrentWorkspace: WF.GetWindowsCurrentWorkspace,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetWindowsCurrentWorkspaceCurrentMonitor | jq .
    // topnotch-call GetWindowsCurrentWorkspaceCurrentMonitor | jq .
    GetWindowsCurrentWorkspaceCurrentMonitor: WF.GetWindowsCurrentWorkspaceCurrentMonitor,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetWindowsCurrentWorkspaceOfFocusedWindowWMClass | jq -r '.[].id'
    // topnotch-call GetWindowsCurrentWorkspaceOfFocusedWindowWMClass | jq -r '.[].id'
    GetWindowsCurrentWorkspaceOfFocusedWindowWMClass: WF.GetWindowsCurrentWorkspaceOfFocusedWindowWMClass,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.ToggleWindowsCurrentWorkspace
    // topnotch-call ToggleWindowsCurrentWorkspace
    ToggleWindowsCurrentWorkspace: WF.ToggleWindowsCurrentWorkspace,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetWindowsExcludingGivenWMClass array:string:"Io.github.cboxdoerfer.FSearch","VSCodium","firefox-esr","Nemo","Alacritty" | jq .
    // topnotch-call GetWindowsExcludingGivenWMClass "Io.github.cboxdoerfer.FSearch,VSCodium,firefox-esr,Nemo,Alacritty" | jq .
    GetWindowsExcludingGivenWMClass: WF.GetWindowsExcludingGivenWMClass,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.GetWindowsGivenWMClass string:"firefox-esr" | jq -r '.[].id'
    // topnotch-call GetWindowsGivenWMClass "firefox-esr" | jq -r '.[].id'
    GetWindowsGivenWMClass: WF.GetWindowsGivenWMClass,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.ToggleLookingGlass
    // topnotch-call ToggleLookingGlass
    ToggleLookingGlass: WF.ToggleLookingGlass,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.MinimizeOtherWindowsOfFocusedWindowWMClass
    // topnotch-call MinimizeOtherWindowsOfFocusedWindowWMClass
    MinimizeOtherWindowsOfFocusedWindowWMClass: WF.MinimizeOtherWindowsOfFocusedWindowWMClass,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowActivateGivenWinID uint32:44129093
    // topnotch-call WindowActivateGivenWinID 44129093
    WindowActivateGivenWinID: WF.WindowActivateGivenWinID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowCloseGivenWinID uint32:44129093
    // topnotch-call WindowCloseGivenWinID 44129093
    WindowCloseGivenWinID: WF.WindowCloseGivenWinID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowFullScreenGivenWinID uint32:44129093
    // topnotch-call WindowFullScreenGivenWinID 44129093
    WindowFullScreenGivenWinID: WF.WindowFullScreenGivenWinID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowMaximizeGivenWinID uint32:3931313482
    // topnotch-call WindowMaximizeGivenWinID 3931313482
    WindowMaximizeGivenWinID: WF.WindowMaximizeGivenWinID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowMinimizeGivenWinID uint32:3931313482
    // topnotch-call WindowMinimizeGivenWinID 3931313482
    WindowMinimizeGivenWinID: WF.WindowMinimizeGivenWinID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowMoveGivenWinID uint32:44129093 uint32:100 uint32:200
    // topnotch-call WindowMoveGivenWinID 44129093 100 200
    WindowMoveGivenWinID: WF.WindowMoveGivenWinID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowMoveResizeGivenWinID uint32:44129093 uint32:0 uint32:0 uint32:800 uint32:600
    // topnotch-call WindowMoveResizeGivenWinID 44129093 0 0 800 600
    WindowMoveResizeGivenWinID: WF.WindowMoveResizeGivenWinID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowMoveToCurrentWorkspace uint32:44129093
    // topnotch-call WindowMoveToCurrentWorkspace 44129093
    WindowMoveToCurrentWorkspace: WF.WindowMoveToCurrentWorkspace,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowMoveToExcludingGivenWMClasses array:string:"Io.github.cboxdoerfer.FSearch","VSCodium","firefox-esr","Nemo","Alacritty" uint32:7
    // topnotch-call WindowMoveToExcludingGivenWMClasses "Io.github.cboxdoerfer.FSearch,VSCodium,firefox-esr,Nemo,Alacritty" 7
    WindowMoveToExcludingGivenWMClasses: WF.WindowMoveToExcludingGivenWMClasses,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowMoveToGivenWorkspaceGivenWinID uint32:44129093 uint32:0
    // topnotch-call WindowMoveToGivenWorkspaceGivenWinID 44129093 0
    WindowMoveToGivenWorkspaceGivenWinID: WF.WindowMoveToGivenWorkspaceGivenWinID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowRaiseGivenWinID uint32:44129093
    // topnotch-call WindowRaiseGivenWinID 44129093
    WindowRaiseGivenWinID: WF.WindowRaiseGivenWinID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowResizeGivenWinID uint32:44129093 uint32:800 uint32:600
    // topnotch-call WindowResizeGivenWinID 44129093 800 600
    WindowResizeGivenWinID: WF.WindowResizeGivenWinID,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowsActivateGivenWMClass string:"firefox-esr"
    // topnotch-call WindowsActivateGivenWMClass "firefox-esr"
    WindowsActivateGivenWMClass: WF.WindowsActivateGivenWMClass,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowsCloseDuplicateNemo
    // topnotch-call WindowsCloseDuplicateNemo
    WindowsCloseDuplicateNemo: WF.WindowsCloseDuplicateNemo,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowsMoveToGivenWorkspaceGivenWMClass string:"firefox-esr" uint32:0
    // topnotch-call WindowsMoveToGivenWorkspaceGivenWMClass "firefox-esr" 0
    WindowsMoveToGivenWorkspaceGivenWMClass: WF.WindowsMoveToGivenWorkspaceGivenWMClass,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Windows io.github.blueray453.TopNotchWorkspaces.Windows.WindowUnminimizeGivenWinID uint32:44129093
    // topnotch-call WindowUnminimizeGivenWinID 44129093
    WindowUnminimizeGivenWinID: WF.WindowUnminimizeGivenWinID,
};

// ==================== Workspaces interface ====================

const WORKSPACES_XML = `
<node>
   <interface name="io.github.blueray453.TopNotchWorkspaces.Workspaces">
      <method name="GetCurrentWorkspace">
         <arg type="s" direction="out" name="workspace"/>
      </method>
      <method name="GetWorkspaceIndexByName">
         <arg type="s" direction="in" name="workspace_name"/>
         <arg type="s" direction="out" name="workspace_num"/>
      </method>
      <method name="GetWorkspaces">
         <arg type="s" direction="out" name="workspaces"/>
      </method>
      <method name="GoToGivenWorkspace">
         <arg type="u" direction="in" name="workspace_num"/>
      </method>
      <method name="MoveFocusedWindowToGivenWorkspace">
         <arg type="u" direction="in" name="workspace_num"/>
      </method>
      <method name="MoveWindowToWorkspace">
         <arg type="u" direction="in" name="win_id"/>
         <arg type="u" direction="in" name="workspace_num"/>
      </method>
      <method name="ToggleWorkspaces"/>
   </interface>
</node>`;

const WORKSPACES_HANDLERS = {
    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Workspaces io.github.blueray453.TopNotchWorkspaces.Workspaces.GetCurrentWorkspace
    // topnotch-call GetCurrentWorkspace
    GetCurrentWorkspace: WSF.GetCurrentWorkspace,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Workspaces io.github.blueray453.TopNotchWorkspaces.Workspaces.GetWorkspaceIndexByName string:"Codium"
    // topnotch-call GetWorkspaceIndexByName "Codium"
    GetWorkspaceIndexByName: WSF.GetWorkspaceIndexByName,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Workspaces io.github.blueray453.TopNotchWorkspaces.Workspaces.GetWorkspaces | jq .
    // topnotch-call GetWorkspaces | jq .
    GetWorkspaces: WSF.GetWorkspaces,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Workspaces io.github.blueray453.TopNotchWorkspaces.Workspaces.GoToGivenWorkspace uint32:4
    // topnotch-call GoToGivenWorkspace 4
    GoToGivenWorkspace: WSF.GoToGivenWorkspace,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Workspaces io.github.blueray453.TopNotchWorkspaces.Workspaces.MoveFocusedWindowToGivenWorkspace uint32:4
    // topnotch-call MoveFocusedWindowToGivenWorkspace 4
    MoveFocusedWindowToGivenWorkspace: WSF.MoveFocusedWindowToGivenWorkspace,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Workspaces io.github.blueray453.TopNotchWorkspaces.Workspaces.MoveWindowToWorkspace uint32:44129093 uint32:0
    // topnotch-call MoveWindowToWorkspace 44129093 0
    MoveWindowToWorkspace: WSF.MoveWindowToWorkspace,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Workspaces io.github.blueray453.TopNotchWorkspaces.Workspaces.ToggleWorkspaces
    // topnotch-call ToggleWorkspaces
    ToggleWorkspaces: WSF.ToggleWorkspaces,
};

// ==================== KeyboardSimulator interface ====================

const KEYBOARD_XML = `
<node>
   <interface name="io.github.blueray453.TopNotchWorkspaces.KeyboardSimulator">
      <method name="PressFromString">
         <arg type="s" direction="in" name="keys"/>
      </method>
      <method name="SelectAllFsearchText"/>
      <method name="TestTypeString"/>
   </interface>
</node>`;

const KEYBOARD_HANDLERS = {
    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/KeyboardSimulator io.github.blueray453.TopNotchWorkspaces.KeyboardSimulator.PressFromString string:"Control_L,Shift_L,Alt_L,Super_L,o"
    // topnotch-call PressFromString "Control_L,Shift_L,Alt_L,Super_L,o"
    PressFromString: KSF.PressFromString,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/KeyboardSimulator io.github.blueray453.TopNotchWorkspaces.KeyboardSimulator.SelectAllFsearchText
    // topnotch-call SelectAllFsearchText
    SelectAllFsearchText: KSF.SelectAllFsearchText,

    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/KeyboardSimulator io.github.blueray453.TopNotchWorkspaces.KeyboardSimulator.TestTypeString
    // topnotch-call TestTypeString
    TestTypeString: KSF.TestTypeString,
};

// ==================== Keybinding interface ====================

const KEYBINDING_XML = `
<node>
   <interface name="io.github.blueray453.TopNotchWorkspaces.Keybinding">
      <method name="SwitchToWorkspace">
         <arg type="u" direction="in" name="workspace_num"/>
      </method>
   </interface>
</node>`;

const KEYBINDING_HANDLERS = {
    // dbus-send --print-reply=literal --session --dest=io.github.blueray453.TopNotchWorkspaces /io/github/blueray453/TopNotchWorkspaces/Keybinding io.github.blueray453.TopNotchWorkspaces.Keybinding.SwitchToWorkspace uint32:0
    // topnotch-call SwitchToWorkspace 0
    SwitchToWorkspace: KBF.SwitchToWorkspace,
};

// ==================== Interface registry ====================

const INTERFACES = [
    { shortName: 'Overlay', xml: OVERLAY_XML, handlers: OVERLAY_HANDLERS },
    { shortName: 'Windows', xml: WINDOWS_XML, handlers: WINDOWS_HANDLERS },
    {
        shortName: 'Workspaces', xml: WORKSPACES_XML, handlers: WORKSPACES_HANDLERS,
        init: WSF.init, destroy: WSF.destroy
    },
    {
        shortName: 'KeyboardSimulator', xml: KEYBOARD_XML, handlers: KEYBOARD_HANDLERS,
        init: KSF.init, destroy: KSF.destroy
    },
    { shortName: 'Keybinding', xml: KEYBINDING_XML, handlers: KEYBINDING_HANDLERS },
].map(i => ({
    ...i,
    path: `${BUS_PATH}/${i.shortName}`,
    ifaceName: `${BUS_NAME}.${i.shortName}`,
}));

// ==================== Lifecycle ====================

const state = { ownerId: 0, exported: new Map() };

function exportAll(connection) {
    for (const iface of INTERFACES) {
        try {
            const exported = Gio.DBusExportedObject.wrapJSObject(iface.xml, iface.handlers);
            exported.export(connection, iface.path);
            iface.init?.();
            state.exported.set(iface.ifaceName, {
                exported,
                init: iface.init,
                destroy: iface.destroy,
            });
            journal(`Exported ${iface.ifaceName} on ${iface.path}`);
        } catch (e) {
            journal(`Failed to export ${iface.ifaceName}: ${e.message}`, true);
            try { iface.destroy?.(); } catch (_) { /* nothing to clean */ }
        }
    }
}

function unexportAll() {
    for (const [ifaceName, { exported, destroy }] of state.exported) {
        try { exported.flush(); exported.unexport(); } catch (e) { /* not exported */ }
        try { destroy?.(); }
        catch (e) { journal(`Error destroying ${ifaceName}: ${e.message}`, true); }
    }
    state.exported.clear();
}

function writeSpecCache() {
    try {
        GLib.mkdir_with_parents(SPEC_CACHE_DIR, 0o755);
        const interfaces = {};
        for (const iface of INTERFACES)
            interfaces[iface.ifaceName] = { object_path: iface.path, xml: iface.xml };
        const spec = { bus_name: BUS_NAME, interfaces };
        GLib.file_set_contents(
            GLib.build_filenamev([SPEC_CACHE_DIR, SPEC_CACHE_FILE]),
            JSON.stringify(spec, null, 2));
        journal(`Wrote spec cache to ${SPEC_CACHE_FILE}`);
    } catch (e) {
        journal(`Failed to write spec cache: ${e.message}`, true);
    }
}

function removeSpecCache() {
    try {
        const f = Gio.File.new_for_path(GLib.build_filenamev([SPEC_CACHE_DIR, SPEC_CACHE_FILE]));
        if (f.query_exists(null)) {
            f.delete(null);
            journal(`Removed spec cache`);
        }
    } catch (e) {
        journal(`Failed to remove spec cache: ${e.message}`, true);
    }
}

export function initDBusService() {
    state.ownerId = Gio.bus_own_name(
        Gio.BusType.SESSION,
        BUS_NAME,
        Gio.BusNameOwnerFlags.NONE,
        exportAll,
        (c, name) => { journal(`${name}: name acquired`); writeSpecCache(); },
        (c, name) => { journal(`${name}: name lost`, true); unexportAll(); },
    );
}

export function destroyDBusService() {
    if (state.ownerId) {
        Gio.bus_unown_name(state.ownerId);
        state.ownerId = 0;
    }
    unexportAll();
    removeSpecCache();
}

// ==================== CLI helpers ====================

const CLIS = [
    { name: 'topnotch-call', path: ['cli', 'topnotch-call'] },
    { name: 'gdmenu', path: ['cli', 'gdmenu'] },
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
            Gio.FileQueryOptions.NOFOLLOW_SYMLINKS, null);
        if (info.get_symlink_target() === cliScript) {
            linkFile.delete(null);
            journal(`[dbusService] CLI symlink removed: ${name}`);
        }
    } catch (e) {
        journal(`[dbusService] CLI remove failed (${name}): ${e.message}`, true);
    }
}