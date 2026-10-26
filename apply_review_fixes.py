#!/usr/bin/env python3
"""
apply_review_fixes.py — apply review-fix edits to the extension tree.

Usage:
    cd /path/to/extension-root
    python3 apply_review_fixes.py --check   # dry-run, prints diffs
    python3 apply_review_fixes.py           # apply

Idempotent: running twice is a no-op. Each (old, new) pair must either
be fully present (old) or already applied (new). Anything else aborts
that file and reports what it expected.
"""

import argparse
import pathlib
import sys

def edit(path: pathlib.Path, pairs, check: bool) -> bool:
    if not path.exists():
        print(f"  MISSING  {path}")
        return False

    text = original = path.read_text()
    for old, new in pairs:
        if old not in text:
            if new in text:
                print(f"  = {path.name}: already applied ({old.splitlines()[0][:60]!r})")
                continue
            print(f"  ✗ {path}: pattern not found:\n    {old!r}")
            return False
        text = text.replace(old, new, 1)

    if text == original:
        print(f"  = {path.name}: no change")
        return True

    print(f"  ✓ {path.name}")
    if check:
        print("    (dry-run; not written)")
    else:
        path.write_text(text)
    return True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="dry-run")
    ap.add_argument("--root", default=".")
    args = ap.parse_args()
    root = pathlib.Path(args.root).resolve()
    print(f"Extension root: {root}\n")

    ok = True

    # ---------- logger.js ----------
    ok &= edit(root / "logger.js", [
        ("    return function journal(msg) {\n", "    return function journal(msg, isError = false) {\n"),
        ("            writeToJournal(output);\n", "            writeToJournal(output, isError);\n"),
        ("function writeToJournal(output) {\n"
         "    GLib.log_structured(\n"
         "        uuid,\n"
         "        GLib.LogLevelFlags.LEVEL_MESSAGE,\n", "function writeToJournal(output, isError = false) {\n"
         "    GLib.log_structured(\n"
         "        uuid,\n"
         "        isError ? GLib.LogLevelFlags.LEVEL_WARNING : GLib.LogLevelFlags.LEVEL_MESSAGE,\n"),
    ], args.check)

    # ---------- lib/dbusService.js ----------
    ok &= edit(root / "lib" / "dbusService.js", [
        ("Gio.FileQueryOptions.NOFOLLOW_SYMLINKS", "Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS"),
        ("    CloseOverlay: () => OverlayService.closeOverlay(),\n",
         "    CloseOverlay: () => { OverlayService.closeOverlay(); },\n"),
        ("    ShowAllApps: () => OverlayService.showAllApps(),\n",
         "    ShowAllApps: () => { OverlayService.showAllApps(); },\n"),
        ("    ShowAllWindows: () => OverlayService.showAllWindows(),\n",
         "    ShowAllWindows: () => { OverlayService.showAllWindows(); },\n"),
        ("    ShowWorkspaceWindows: (n) => OverlayService.showWorkspaceWindows(n),\n",
         "    ShowWorkspaceWindows: (n) => { OverlayService.showWorkspaceWindows(n); },\n"),
        ("    ToggleAllApps: () => OverlayService.toggleAllApps(),\n",
         "    ToggleAllApps: () => { OverlayService.toggleAllApps(); },\n"),
        ("    ToggleAllWindows: () => OverlayService.toggleAllWindows(),\n",
         "    ToggleAllWindows: () => { OverlayService.toggleAllWindows(); },\n"),
        ("    ToggleWorkspaceWindows: (n) => OverlayService.toggleWorkspaceWindows(n),\n",
         "    ToggleWorkspaceWindows: (n) => { OverlayService.toggleWorkspaceWindows(n); },\n"),
        ("    CycleWindowsOnWorkspace: (n) => WorkspaceActions.cycleWindowsOnWorkspace(n, 1),\n",
         "    CycleWindowsOnWorkspace: (n) => { WorkspaceActions.cycleWindowsOnWorkspace(n, 1); },\n"),
    ], args.check)

    # ---------- lib/windowFunctions.js ----------
    ok &= edit(root / "lib" / "windowFunctions.js", [
        ("""    let windowReadyId = 0;

    windowReadyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        meta_window.move_resize_frame(1, x_coordinate, y_coordinate, width, height);
        journal(`Alhamdulillah, moved meta_window`);
        windowReadyId = 0;
        return GLib.SOURCE_REMOVE;
    });

    meta_window.connect('unmanaging', () => {
        if (windowReadyId)
            GLib.Source.remove(windowReadyId);
    });
""", """    let windowReadyId = 0;
    let unmanagingId = 0;

    const cleanup = () => {
        if (unmanagingId) {
            try { meta_window.disconnect(unmanagingId); } catch (e) { /* gone */ }
            unmanagingId = 0;
        }
    };

    windowReadyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
            meta_window.move_resize_frame(1, x_coordinate, y_coordinate, width, height);
            journal(`Alhamdulillah, moved meta_window`);
        } finally {
            windowReadyId = 0;
            cleanup();
        }
        return GLib.SOURCE_REMOVE;
    });

    unmanagingId = meta_window.connect('unmanaging', () => {
        if (windowReadyId) {
            try { GLib.Source.remove(windowReadyId); } catch (e) { /* gone */ }
            windowReadyId = 0;
        }
        unmanagingId = 0;
    });
"""),
        ("""export function ToggleWindowsCurrentWorkspace() {
    let windows = getNormalWindowsCurrentWorkspace();
    if (windows.length !== 2) return false;

    let hiddenWindow = windows.find(w => !w.showing_on_its_workspace());
    if (hiddenWindow) {
        hiddenWindow.unminimize();
        hiddenWindow.maximize(3);
        WorkspaceActions.navigateToWindowMru(hiddenWindow);
        return true;
    }

    let covered = windows.find(w => coverage.isCoveredPartially(w));
    if (!covered) return false;

    WorkspaceActions.navigateToWindowMru(covered);
    return true;
}
""", """export function ToggleWindowsCurrentWorkspace() {
    let windows = getNormalWindowsCurrentWorkspace();
    if (windows.length !== 2) return;

    let hiddenWindow = windows.find(w => !w.showing_on_its_workspace());
    if (hiddenWindow) {
        hiddenWindow.unminimize();
        hiddenWindow.maximize(3);
        WorkspaceActions.navigateToWindowMru(hiddenWindow);
        return;
    }

    let covered = windows.find(w => coverage.isCoveredPartially(w));
    if (!covered) return;

    WorkspaceActions.navigateToWindowMru(covered);
}
"""),
        ("    getOtherNormalWindowsCurrentWorkspaceOfFocusedWindowWmClass().map(w => w.minimize());\n",
         "    getOtherNormalWindowsCurrentWorkspaceOfFocusedWindowWmClass().forEach(w => w.minimize());\n"),
    ], args.check)

    # ---------- lib/genericOverlay.js ----------
    ok &= edit(root / "lib" / "genericOverlay.js", [
        ("        this._items = items.map(it => ({\n"
         "            id: String(it.id ?? it.label ?? it),\n", "        this._items = items.map((it, i) => ({\n"
         "            id: String(it.id ?? i),\n"),
    ], args.check)

    # ---------- lib/windowOverlay.js ----------
    ok &= edit(root / "lib" / "windowOverlay.js", [
        ("        const persisted = Model.intent.overlayFilters ?? {};\n"
         "        this._filters = {\n"
         "            workspace: initialFilters?.workspace ?? persisted.workspace ?? null,\n"
         "            app: initialFilters?.app ?? persisted.app ?? null,\n"
         "            pinnedOnly: initialFilters?.pinnedOnly ?? persisted.pinnedOnly ?? false,\n"
         "        };\n"
         "        this._persistFilters();\n",
         "        const persisted = initialFilters ? (Model.intent.overlayFilters ?? {}) : {};\n"
         "        this._filters = {\n"
         "            workspace: initialFilters?.workspace ?? persisted.workspace ?? null,\n"
         "            app: initialFilters?.app ?? persisted.app ?? null,\n"
         "            pinnedOnly: initialFilters?.pinnedOnly ?? persisted.pinnedOnly ?? false,\n"
         "        };\n"
         "        if (initialFilters) this._persistFilters();\n"),
    ], args.check)

    # ---------- lib/workspaceIndicator.js ----------
    ok &= edit(root / "lib" / "workspaceIndicator.js", [
        ("        this._mainBox?.destroy();\n"
         "\n"
         "        Main.panel.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);\n"
         "\n"
         "        super.destroy();\n", "        this._mainBox?.destroy();\n"
         "\n"
         "        super.destroy();\n"),
    ], args.check)

    # ---------- lib/workspaceFunctions.js ----------
    ok &= edit(root / "lib" / "workspaceFunctions.js", [
        ("export function GetWorkspaceIndexByName(workspaceName) {\n"
         "    const n = WorkspaceManager.get_n_workspaces();\n"
         "    for (let i = 0; i < n; i++) {\n"
         "        if (Meta.prefs_get_workspace_name(i) == workspaceName) {\n"
         "            return JSON.stringify(i);\n"
         "        }\n"
         "    }\n"
         "}\n", "export function GetWorkspaceIndexByName(workspaceName) {\n"
         "    const n = WorkspaceManager.get_n_workspaces();\n"
         "    for (let i = 0; i < n; i++) {\n"
         "        if (Meta.prefs_get_workspace_name(i) == workspaceName) {\n"
         "            return JSON.stringify(i);\n"
         "        }\n"
         "    }\n"
         "    return JSON.stringify(null);\n"
         "}\n"),
    ], args.check)

    # ---------- lib/model.js ----------
    ok &= edit(root / "lib" / "model.js", [
        ("    if (settings) {\n"
         "        _listen(settings, 'changed', () => {\n"
         "            applySettings(settings);\n"
         "            requestRender();\n"
         "        });\n"
         "    }\n", "    if (settings) {\n"
         "        _listen(settings, 'changed', (_s, key) => {\n"
         "            if (key.startsWith('discovered-')) return;\n"
         "            applySettings(settings);\n"
         "            requestRender();\n"
         "        });\n"
         "    }\n"),
    ], args.check)

    # ---------- lib/pinnedEdgeFlyout.js ----------
    ok &= edit(root / "lib" / "pinnedEdgeFlyout.js", [
        ("            for (const delay of [0, 300, 1000]) {\n"
         "                if (delay === 0) {\n"
         "                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {\n"
         "                        if (this._destroying) return GLib.SOURCE_REMOVE;\n"
         "                        this._forceIconSizes('idle');\n"
         "                        this._hideNonFavoriteApps();\n"
         "                        return GLib.SOURCE_REMOVE;\n"
         "                    });\n"
         "                } else {\n"
         "                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {\n"
         "                        if (this._destroying) return GLib.SOURCE_REMOVE;\n"
         "                        this._forceIconSizes(`timeout-${delay}`);\n"
         "                        this._hideNonFavoriteApps();\n"
         "                        return GLib.SOURCE_REMOVE;\n"
         "                    });\n"
         "                }\n"
         "            }\n", "            this._initTimeoutIds = [];\n"
         "            for (const delay of [0, 300, 1000]) {\n"
         "                if (delay === 0) {\n"
         "                    this._initTimeoutIds.push(GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {\n"
         "                        if (this._destroying) return GLib.SOURCE_REMOVE;\n"
         "                        this._forceIconSizes('idle');\n"
         "                        this._hideNonFavoriteApps();\n"
         "                        return GLib.SOURCE_REMOVE;\n"
         "                    }));\n"
         "                } else {\n"
         "                    this._initTimeoutIds.push(GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {\n"
         "                        if (this._destroying) return GLib.SOURCE_REMOVE;\n"
         "                        this._forceIconSizes(`timeout-${delay}`);\n"
         "                        this._hideNonFavoriteApps();\n"
         "                        return GLib.SOURCE_REMOVE;\n"
         "                    }));\n"
         "                }\n"
         "            }\n"),
        ("        destroy() {\n"
         "            this._destroying = true;\n"
         "            Interactions.getTooltip().hideNow();\n"
         "            if (this._setGeometryTimeout) {\n", "        destroy() {\n"
         "            this._destroying = true;\n"
         "            Interactions.getTooltip().hideNow();\n"
         "            for (const id of (this._initTimeoutIds ?? [])) {\n"
         "                try { GLib.Source.remove(id); } catch (e) { /* gone */ }\n"
         "            }\n"
         "            this._initTimeoutIds = [];\n"
         "            if (this._setGeometryTimeout) {\n"),
        ("        this._grabActive = false;\n"
         "        this._needLeave = false;\n"
         "\n"
         "        this._poll = new Poller(this._scope, {\n", "        this._grabActive = false;\n"
         "        this._needLeave = false;\n"
         "        this._dashFailures = 0;\n"
         "\n"
         "        this._poll = new Poller(this._scope, {\n"),
        ("        journal('[pinnedEdge] show-apps requested');\n"
         "        this._close('show-apps');\n"
         "        GLib.timeout_add(GLib.PRIORITY_DEFAULT, Motion.dur('dashClose') + 20, () => {\n"
         "            this._onShowAppsCb?.();\n"
         "            return GLib.SOURCE_REMOVE;\n"
         "        });\n", "        journal('[pinnedEdge] show-apps requested');\n"
         "        this._close('show-apps');\n"
         "        this._scope.timeout(Motion.dur('dashClose') + 20, () => {\n"
         "            this._onShowAppsCb?.();\n"
         "            return GLib.SOURCE_REMOVE;\n"
         "        });\n"),
        ("    _tick() {\n"
         "        if (!this._dash && !this._ensureDash()) return;\n"
         "\n"
         "        const [x, y, mods] = global.get_pointer();\n", "    _tick() {\n"
         "        if (!this._dash && !this._ensureDash()) {\n"
         "            if (++this._dashFailures > 3) {\n"
         "                journal('[pinnedEdge] dash creation failed repeatedly — stopping poll');\n"
         "                this._poll.stop();\n"
         "            }\n"
         "            return;\n"
         "        }\n"
         "        if (this._dash) this._dashFailures = 0;\n"
         "\n"
         "        const [x, y, mods] = global.get_pointer();\n"),
    ], args.check)

    # ---------- lib/peekController.js ----------
    ok &= edit(root / "lib" / "peekController.js", [
        ("        this._switchPending = null;\n"
         "        this._dragOrigWs = null;\n"
         "    }\n", "        this._switchPending = null;\n"
         "        this._dragOrigWs = null;\n"
         "        this._finishDragId = 0;\n"
         "    }\n"),
        ("            if (inside) {\n"
         "                s.keepStack = true;\n"
         "                const win = s.win;\n"
         "                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {\n"
         "                    WorkspaceActions.navigateToWindowMru(win);\n"
         "                    return GLib.SOURCE_REMOVE;\n"
         "                });\n"
         "            }\n", "            if (inside) {\n"
         "                s.keepStack = true;\n"
         "                const win = s.win;\n"
         "                if (this._finishDragId) {\n"
         "                    try { GLib.Source.remove(this._finishDragId); } catch (e) { /* gone */ }\n"
         "                }\n"
         "                this._finishDragId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {\n"
         "                    this._finishDragId = 0;\n"
         "                    WorkspaceActions.navigateToWindowMru(win);\n"
         "                    return GLib.SOURCE_REMOVE;\n"
         "                });\n"
         "            }\n"),
        ("        this._cancelSwitch();\n"
         "        if (this._hideTimer) { GLib.Source.remove(this._hideTimer); this._hideTimer = 0; }\n"
         "        this._teardown();\n", "        this._cancelSwitch();\n"
         "        if (this._hideTimer) { GLib.Source.remove(this._hideTimer); this._hideTimer = 0; }\n"
         "        if (this._finishDragId) {\n"
         "            try { GLib.Source.remove(this._finishDragId); } catch (e) { /* gone */ }\n"
         "            this._finishDragId = 0;\n"
         "        }\n"
         "        this._teardown();\n"),
    ], args.check)

    # ---------- lib/keyboardSimulatorFunctions.js ----------
    ok &= edit(root / "lib" / "keyboardSimulatorFunctions.js", [
        ("function typeString(text) {\n", "let _virtualKeyboard = null;\n"
         "function getVirtualKeyboard() {\n"
         "    if (!_virtualKeyboard) {\n"
         "        _virtualKeyboard = Clutter.get_default_backend()\n"
         "            .get_default_seat()\n"
         "            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);\n"
         "    }\n"
         "    return _virtualKeyboard;\n"
         "}\n"
         "\n"
         "function typeString(text) {\n"),
        ("function pressKeys(keys) {\n"
         "    const VirtualKeyboard = Clutter.get_default_backend()\n"
         "        .get_default_seat()\n"
         "        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);\n", "function pressKeys(keys) {\n"
         "    const VirtualKeyboard = getVirtualKeyboard();\n"),
        ("function keysReleased(onReleased) {\n"
         "    state.attempts = 0;\n", "function keysReleased(onReleased) {\n"
         "    if (state.timeoutId) {\n"
         "        try { GLib.Source.remove(state.timeoutId); } catch (e) { /* gone */ }\n"
         "        state.timeoutId = 0;\n"
         "    }\n"
         "    state.attempts = 0;\n"),
    ], args.check)

    # ---------- stylesheet.css ----------
    ok &= edit(root / "stylesheet.css", [
        (".window-selector-overlay .overlay-search-entry {\n"
         "    padding: 4px 12px;\n"
         "}\n"
         "\n", ""),
    ], args.check)

    # ---------- prefs.js ----------
    ok &= edit(root / "prefs.js", [
        ("        Gtk.StyleContext.add_provider_for_display(\n"
         "            Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);\n"
         "\n"
         "        let dragged = null;\n"
         "        const cleanups = [];\n", "        const display = Gdk.Display.get_default();\n"
         "        Gtk.StyleContext.add_provider_for_display(\n"
         "            display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);\n"
         "\n"
         "        let dragged = null;\n"
         "        const cleanups = [];\n"
         "        cleanups.push(() => {\n"
         "            try {\n"
         "                Gtk.StyleContext.remove_provider_for_display(display, css);\n"
         "            } catch (e) { /* gone */ }\n"
         "        });\n"),
    ], args.check)

    print("\n" + ("All files OK." if ok else "Some files failed — see ✗ above."))
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
