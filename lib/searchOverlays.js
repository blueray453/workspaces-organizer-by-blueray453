import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';

import { Scope } from './scheduling.js';
import { Display } from './model.js';
import {
    createReorderGhost, createDropStrip, DragMotionResult,
    makeDraggable, getTooltip, settleIcon,
} from './interactions.js';
import {
    getWindowAppIcon, computeOverlayLayout, createOverlayContainer, createSearchEntry,
    createResultsScroll, createPreviewBox, createResultRow, createPinnedBar, createPinnedIcon,
    createClonePreview, createAppPreview,
} from './ui.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== fuzzy matching ====================
function subsequenceMatch(query, text) {
    let qi = 0, score = 0, consecutive = 0;
    for (let ti = 0; ti < text.length && qi < query.length; ti++) {
        if (text[ti] === query[qi]) { score += 1 + consecutive; consecutive++; qi++; }
        else consecutive = 0;
    }
    return qi < query.length ? { matched: false, score: -1 } : { matched: true, score };
}

function fuzzyMatch(query, text) {
    const trimmed = query.trim();
    if (!trimmed) return { matched: true, score: 0 };
    const lowerText = text.toLowerCase();
    let score = 0;
    for (const token of trimmed.toLowerCase().split(/\s+/).filter(t => t.length > 0)) {
        const idx = lowerText.indexOf(token);
        if (idx !== -1) { score += 50 - Math.min(idx, 40); continue; }
        const sub = subsequenceMatch(token, lowerText);
        if (!sub.matched) return { matched: false, score: -1 };
        score += sub.score;
    }
    return { matched: true, score };
}

// ==================== shared overlay base ====================
export class SearchOverlayBase {
    static _current = null;

    static get current() {
        if (SearchOverlayBase._current?._closed) SearchOverlayBase._current = null;
        return SearchOverlayBase._current;
    }

    static closeCurrent() {
        const overlay = SearchOverlayBase.current;
        if (!overlay) return false;
        overlay._close();
        return true;
    }

    constructor(settings) {
        this._settings = settings;
        this._results = [];
        this._buttons = [];
        this._selectedIndex = -1;
        this._previewContent = null;
        this._modalGrab = null;
        this._closed = false;

        this._scope = new Scope();
        this._rowsScope = new Scope();
        this._previewScope = new Scope();
    }

    _getHintText() { return 'Search…'; }
    _getAllResultsSorted() { return []; }
    _getSearchLabel(item) { return item.name ?? ''; }
    _buildResultRow(item, index) { throw new Error('_buildResultRow must be implemented'); }
    _updatePreviewContent(item) { }
    _activateResult(index) { }

    _getRestoreKey(item) { return null; }
    _onBeforeClose() { }
    _handleExtraKeys(event, symbol) { return undefined; }

    _computeLayout(monitor) { return computeOverlayLayout(monitor); }

    _buildContainer(monitor) { this._container = createOverlayContainer(monitor); }

    _buildEntry(layout) {
        this._entry = createSearchEntry({
            x: layout.panelX, y: layout.entryY, width: layout.panelWidth, height: layout.entryHeight,
            hint: this._getHintText(),
            fontSize: this._settings.get_int('collection-search-font-size'),
        });
        this._scope.connect(this._entry.clutter_text, 'text-changed', () => this._onSearchChanged());
        this._scope.connect(this._entry.clutter_text, 'key-press-event', (a, e) => this._onKeyPress(e));
    }

    _buildResultsAndPreview(layout, { previewVertical = false } = {}) {
        const { scroll, box } = createResultsScroll({
            x: layout.panelX, y: layout.panelTop, width: layout.resultsWidth, height: layout.panelHeight,
        });
        this._resultsScroll = scroll;
        this._resultsBox = box;
        this._previewBox = createPreviewBox({
            x: layout.panelX + layout.resultsWidth + 20, y: layout.panelTop,
            width: layout.previewWidth, height: layout.panelHeight,
            vertical: previewVertical,
        });
    }

    _open() {
        Main.layoutManager.addChrome(this._container, { affectsInputRegion: true, trackFullscreen: true });
        Main.layoutManager.uiGroup.set_child_above_sibling(this._container, null);
        this._modalGrab = Main.pushModal(this._container, { actionMode: Shell.ActionMode.NORMAL });
        this._entry.grab_key_focus();
        SearchOverlayBase._current = this;

        // Any window-focus change closes the overlay. The modal grab makes
        // this rare (alt-tab, a programmatic focus steal), but when it does
        // happen the user has left us, so don't fight it.
        this._scope.connect(Display, 'notify::focus-window', () => {
            if (this._closed) return;
            this._close();
        });
    }

    _close() {
        if (this._closed) return;
        this._closed = true;
        getTooltip().hide();
        this._clearPreview();
        this._onBeforeClose();

        if (this._modalGrab) { Main.popModal(this._modalGrab); this._modalGrab = null; }
        this._rowsScope.dispose();
        this._previewScope.dispose();
        this._scope.dispose();

        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
    }

    _onSearchChanged() {
        if (this._closed) return;
        const query = this._entry.get_text();
        const all = this._getAllResultsSorted();
        if (!query.trim()) { this._setResults(all); return; }
        const scored = [];
        for (const item of all) {
            const r = fuzzyMatch(query, this._getSearchLabel(item));
            if (r.matched) scored.push({ ...item, score: r.score });
        }
        scored.sort((a, b) => b.score - a.score);
        this._setResults(scored);
    }

    _setResults(results) {
        const previousKey = this._selectedIndex >= 0
            ? this._getRestoreKey(this._results[this._selectedIndex])
            : null;

        this._results = results;
        this._rowsScope.dispose();
        this._rowsScope = new Scope();
        this._resultsBox.destroy_all_children();
        this._buttons = [];
        this._selectedIndex = -1;

        results.forEach((item, index) => {
            const button = this._buildResultRow(item, index);
            this._rowsScope.connect(button, 'clicked', () => this._activateResult(index));
            this._rowsScope.connect(button, 'notify::hover', () => { if (button.hover) this._selectIndex(index); });
            this._resultsBox.add_child(button);
            this._buttons.push(button);
        });

        if (results.length === 0) { this._clearPreview(); return; }

        const restoredIndex = previousKey !== null
            ? results.findIndex(item => this._getRestoreKey(item) === previousKey)
            : -1;
        this._selectIndex(restoredIndex >= 0 ? restoredIndex : 0);
    }

    _selectIndex(index) {
        if (this._closed) return;
        if (index < 0 || index >= this._results.length) return;
        if (this._selectedIndex >= 0 && this._buttons[this._selectedIndex])
            this._buttons[this._selectedIndex].remove_style_class_name('selected');
        this._selectedIndex = index;
        this._buttons[index]?.add_style_class_name('selected');
        this._updatePreview(this._results[index]);
    }

    _updatePreview(item) { this._clearPreview(); this._updatePreviewContent(item); }

    _clearPreview() {
        this._previewScope.dispose();
        this._previewScope = new Scope();
        if (!this._previewContent) return;
        if (this._previewContent.get_parent() === this._previewBox)
            this._previewBox.remove_child(this._previewContent);
        this._previewContent.destroy();
        this._previewContent = null;
    }

    _onKeyPress(event) {
        if (this._closed) return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        const handled = this._handleExtraKeys(event, symbol);
        if (handled !== undefined) return handled;

        switch (symbol) {
            case Clutter.KEY_Escape:
                this._close();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                if (this._selectedIndex < this._results.length - 1) this._selectIndex(this._selectedIndex + 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
                if (this._selectedIndex > 0) this._selectIndex(this._selectedIndex - 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
                if (this._selectedIndex >= 0) this._activateResult(this._selectedIndex);
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }
}

// ==================== window search overlay ====================
const NEMO_WM_CLASS = 'Nemo';
const FILE_PROGRESS_INSTANCE = 'file_progress';

export class WindowSearchOverlay extends SearchOverlayBase {
    constructor(windows, settings, focusedWindow = null) {
        super(settings);
        journal(`[WindowSearchOverlay] Opening with ${windows.length} windows`);
        this._windows = windows;
        // Snapshot of the window that had focus when the overlay opened.
        // Used once to sort it to the top and mark its row; never updated,
        // because any focus change now closes the overlay.
        this._focusedWindow = focusedWindow ?? Display.focus_window;
        this._buildUI();
        this._setResults(this._getAllResultsSorted());
        this._open();
    }

    _getHintText() { return 'Search windows…'; }
    _getSearchLabel(item) { return `${item.title} — ${item.appName}`; }

    _getAppName(window) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        return app ? app.get_name() : (window.get_wm_class() || 'Unknown');
    }

    _getAllResultsSorted() {
        const deduped = this._dedupeNemoWindows(this._windows.filter(w => w && !w.skip_taskbar));
        const items = deduped.map(w => ({
            window: w,
            title: w.get_title() || 'Untitled Window',
            appName: this._getAppName(w),
            icon: getWindowAppIcon(w),
        }));
        items.sort((a, b) => a.appName.localeCompare(b.appName) || a.title.localeCompare(b.title));
        if (this._focusedWindow) {
            const i = items.findIndex(item => item.window === this._focusedWindow);
            if (i > 0) items.unshift(...items.splice(i, 1));
        }
        return items;
    }

    _dedupeNemoWindows(windows) {
        const keptByTitle = new Map();
        const result = [];
        for (const w of windows) {
            const isNemo = w.get_wm_class() === NEMO_WM_CLASS;
            const isProgress = w.get_wm_class_instance() === FILE_PROGRESS_INSTANCE;
            if (!isNemo || isProgress) { result.push(w); continue; }

            const key = w.get_title();
            const existing = keptByTitle.get(key);
            if (!existing) { keptByTitle.set(key, w); result.push(w); continue; }
            if (w.get_user_time() > existing.get_user_time()) {
                const idx = result.indexOf(existing);
                if (idx !== -1) result.splice(idx, 1);
                journal(`[WindowSearchOverlay] Closing duplicate Nemo window: "${existing.get_title()}"`);
                existing.delete(0);
                keptByTitle.set(key, w);
                result.push(w);
            } else {
                journal(`[WindowSearchOverlay] Closing duplicate Nemo window: "${w.get_title()}"`);
                w.delete(0);
            }
        }
        return result;
    }

    _buildUI() {
        const layout = this._computeLayout(Main.layoutManager.primaryMonitor);
        this._buildContainer(layout.monitor);
        this._buildEntry(layout);
        this._buildResultsAndPreview(layout);
        this._container.add_child(this._entry);
        this._container.add_child(this._resultsScroll);
        this._container.add_child(this._previewBox);
    }

    _close() {
        if (this._closed) return;
        journal(`[WindowSearchOverlay] Closing`);
        super._close();
    }

    _buildResultRow(item, index) {
        const button = createResultRow({
            icon: item.icon,
            label: `${item.title}  —  ${item.appName}`,
            iconSize: this._settings.get_int('collection-result-icon-size'),
            fontSize: this._settings.get_int('collection-result-font-size'),
            focused: item.window === this._focusedWindow,
        });

        makeDraggable(button, {
            iconSize: this._settings.get_int('icon-size'),
            payload: { kind: 'window', window: item.window, gicon: item.icon },
            onDragBegin: () => this._onResultDragBegin(),
            onDragEnd: () => this._onResultDragEnd(),
        });
        return button;
    }

    _updatePreviewContent(item) {
        const window = item.window;
        const frame = window.get_frame_rect();
        if (frame.height === 0) return;

        const aspect = frame.width / frame.height;
        let h = this._previewBox.height;
        let w = h * aspect;
        if (w > this._previewBox.width) { w = this._previewBox.width; h = w / aspect; }

        const built = createClonePreview(window, h, {
            closeButtonSize: this._settings.get_int('close-button-size'),
        });
        if (!built) return;

        if (built.closeButton)
            this._previewScope.connect(built.closeButton, 'clicked', () => {
                this._closeWindowFromPreview(window);
                return Clutter.EVENT_STOP;
            });

        built.actor.set_position(
            Math.max(0, (this._previewBox.width - built.width) / 2),
            Math.max(0, (this._previewBox.height - built.height) / 2));
        this._previewBox.add_child(built.actor);
        this._previewContent = built.actor;
    }

    _closeWindowFromPreview(window) {
        if (this._closed) return;
        window.delete(global.get_current_time());

        const i = this._results.findIndex(it => it.window === window);
        if (i === -1) return;

        this._results.splice(i, 1);
        this._windows = this._windows.filter(w => w !== window);

        const button = this._buttons[i];
        if (button) {
            if (button.get_parent() === this._resultsBox) this._resultsBox.remove_child(button);
            button.destroy();
        }
        this._buttons.splice(i, 1);

        if (this._results.length === 0) { this._selectedIndex = -1; this._clearPreview(); return; }
        this._selectedIndex = -1;
        this._selectIndex(Math.min(i, this._results.length - 1));
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (!item) return;
        const window = item.window;
        if (window.minimized) window.unminimize();
        window.get_workspace().activate_with_focus(window, global.get_current_time());
        this._close();
    }

    // Shell DND installs its own stage grab during drag-begin and releases
    // it at drag-end; popModal / destroy() synchronously from inside those
    // signals can leave the grab stuck. Hide on an idle after drag-begin,
    // destroy on an idle after drag-end.
    _onResultDragBegin() {
        if (this._closed) return;
        this._closed = true;
        journal(`[WindowSearchOverlay] Drag started on result — closing overlay, drag continues`);
        this._scope.idle(() => { this._teardownVisibleOverlay(); return GLib.SOURCE_REMOVE; });
    }

    _onResultDragEnd() {
        this._scope.idle(() => { this._destroyContainerAfterDrag(); return GLib.SOURCE_REMOVE; });
    }

    _teardownVisibleOverlay() {
        if (!this._container) return;
        this._clearPreview();
        if (this._modalGrab) { Main.popModal(this._modalGrab); this._modalGrab = null; }
        this._scope.disconnectSignals();
        Main.layoutManager.removeChrome(this._container);
        this._container.hide();
    }

    _destroyContainerAfterDrag() {
        if (this._modalGrab) { Main.popModal(this._modalGrab); this._modalGrab = null; }
        this._rowsScope.dispose();
        this._scope.dispose();
        if (this._container) { this._container.destroy(); this._container = null; }
    }
}

// ==================== app search overlay ====================
const PINNED_ICON_SIZE = 96;
const PINNED_BAR_HEIGHT = 120;

export class AppSearchOverlay extends SearchOverlayBase {
    constructor(settings) {
        super(settings);
        this._favorites = AppFavorites.getAppFavorites();
        this._menuManager = null;
        this._openMenu = null;

        this._pinnedDragActive = false;
        this._justDroppedAppId = null;
        this._allItemsCache = null;
        this._pinnedScope = new Scope();

        this._ghost = createReorderGhost({ iconSize: PINNED_ICON_SIZE });

        this._buildUI();
        this._setResults(this._getAllResultsSorted());
        this._open();
    }

    _getHintText() { return 'Search apps… (Ctrl+P: pin/unpin)'; }
    _getSearchLabel(item) { return item.name ?? ''; }
    _getRestoreKey(item) { return item.app.get_id(); }

    _handleExtraKeys(event, symbol) {
        if (symbol === Clutter.KEY_p && (event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
            if (this._selectedIndex >= 0) this._togglePin(this._results[this._selectedIndex]);
            return Clutter.EVENT_STOP;
        }
        return undefined;
    }

    _getAllApps() {
        const appSystem = Shell.AppSystem.get_default();
        let appInfos = [];
        if (appSystem && typeof appSystem.get_all === 'function') {
            try {
                appInfos = appSystem.get_all().filter(app => {
                    try { return app.should_show(); } catch { return false; }
                });
            } catch (e) {
                journal(`[AppSearchOverlay] Shell.AppSystem.get_all() failed: ${e.message}`);
            }
        }
        if (appInfos.length === 0) {
            try {
                const gioApps = Gio.AppInfo.get_all().filter(app => {
                    try { return app.should_show(); } catch { return false; }
                });
                for (const info of gioApps) {
                    let shellApp = null;
                    if (appSystem && typeof appSystem.lookup_app === 'function') {
                        try { shellApp = appSystem.lookup_app(info.get_id()); } catch (e) { }
                    }
                    appInfos.push(shellApp || info);
                }
            } catch (e) {
                journal(`[AppSearchOverlay] Gio.AppInfo fallback failed: ${e.message}`);
                return [];
            }
        }
        return appInfos;
    }

    _getAllResultsSorted() {
        if (this._allItemsCache) return this._allItemsCache;

        try {
            const apps = this._getAllApps();
            if (!apps || apps.length === 0) {
                journal('[AppSearchOverlay] No apps found');
                return (this._allItemsCache = []);
            }

            const favoriteIds = new Set();
            for (const fav of this._favorites.getFavorites()) {
                try { const id = fav.get_id(); if (id) favoriteIds.add(id); }
                catch (e) { journal(`[AppSearchOverlay] Fav error: ${e.message}`); }
            }

            const items = [];
            for (const app of apps) {
                try {
                    const id = typeof app.get_id === 'function' ? app.get_id() : String(app);
                    if (!id) continue;
                    const name = typeof app.get_name === 'function' ? (app.get_name() || '') : (String(app) || '');
                    const icon = typeof app.get_icon === 'function' ? (app.get_icon() || null) : null;
                    items.push({ app, name, icon, pinned: favoriteIds.has(id) });
                } catch (e) {
                    journal(`[AppSearchOverlay] Skipping app: ${e.message}`);
                }
            }
            items.sort((a, b) => a.name.localeCompare(b.name));
            return (this._allItemsCache = items);
        } catch (e) {
            journal(`[AppSearchOverlay] CRITICAL ERROR: ${e.message}\n${e.stack}`);
            return (this._allItemsCache = []);
        }
    }

    _launchApp(app) {
        const name = typeof app.get_name === 'function' ? app.get_name() : 'unknown';
        try {
            app.launch(global.get_current_time(), -1, 0);
            journal(`[AppSearchOverlay] ✅ Launched successfully: ${name}`);
            return true;
        } catch (e) {
            journal(`[AppSearchOverlay] ❌ Launch failed for ${name}: ${e.message}`, true);
            return false;
        }
    }

    _buildUI() {
        const layout = this._computeLayout(Main.layoutManager.primaryMonitor);
        const { monitor, margin, panelWidth, panelX, entryY } = layout;

        this._buildContainer(monitor);
        this._buildEntry(layout);
        this._buildResultsAndPreview(layout, { previewVertical: true });

        this._pinnedBarBox = createPinnedBar(PINNED_BAR_HEIGHT);
        this._pinnedStrip = createDropStrip({
            container: this._pinnedBarBox,
            ghost: this._ghost,
            acceptSource: source => source?._dragPayload?.kind === 'app',
            externalResult: DragMotionResult.NO_DROP,
            hint: {
                show: (anchor, text) => getTooltip().showAbove(
                    anchor, text, this._settings.get_int('tooltip-font-size')),
                hide: () => getTooltip().hide(),
            },
            hintText: insertion => {
                if (!insertion.neighbor) return 'Pin here';
                const name = insertion.neighbor._appName ?? '';
                return insertion.insertBefore ? `Move before ${name}` : `Move after ${name}`;
            },
            onDrop: (source, index, actor) => this._dropPinned(source, index, actor),
        });
        this._pinnedBarBox._delegate = this._pinnedStrip.delegate();

        const mainVertical = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });

        const pinnedWrapper = new St.BoxLayout({
            vertical: false, x_expand: true, y_expand: false, style: 'padding: 0 0 8px 0;',
        });
        pinnedWrapper.add_child(this._pinnedBarBox);

        const entryWrapper = new St.BoxLayout({ vertical: false, x_expand: true, y_expand: false });
        entryWrapper.add_child(this._entry);

        const resultsPreviewRow = new St.BoxLayout({ vertical: false, x_expand: true, y_expand: true });
        resultsPreviewRow.add_child(this._resultsScroll);
        resultsPreviewRow.add_child(this._previewBox);

        mainVertical.add_child(pinnedWrapper);
        mainVertical.add_child(entryWrapper);
        mainVertical.add_child(resultsPreviewRow);
        mainVertical.set_position(panelX, entryY);
        mainVertical.set_size(panelWidth, monitor.height - margin * 2);
        this._container.add_child(mainVertical);

        this._scope.connect(this._favorites, 'changed', () => this._onFavoritesChanged());
        this._scope.connect(Shell.AppSystem.get_default(), 'installed-changed', () => {
            this._allItemsCache = null;
        });

        this._renderPinnedBar();
    }

    _renderPinnedBar() {
        this._pinnedScope.dispose();
        this._pinnedScope = new Scope();
        this._pinnedBarBox.destroy_all_children();

        const favorites = this._favorites.getFavorites();
        if (!favorites || favorites.length === 0) { this._pinnedBarBox.hide(); return; }
        this._pinnedBarBox.show();

        for (const app of favorites) {
            const gicon = app.get_icon();
            if (!gicon) continue;

            const id = app.get_id();
            const name = app.get_name?.() || '';

            const button = createPinnedIcon(gicon, PINNED_ICON_SIZE);
            button._appName = name;

            this._pinnedScope.connect(button, 'notify::hover', () => {
                if (this._pinnedDragActive || !button.hover) getTooltip().hide();
                else getTooltip().showBelow(button, name, this._settings.get_int('tooltip-font-size'));
            });
            this._pinnedScope.connect(button, 'clicked', () => { this._launchApp(app); this._close(); });
            this._pinnedScope.connect(button, 'button-press-event', (a, e) => {
                if (e.get_button() === Clutter.BUTTON_SECONDARY) {
                    this._openContextMenuForApp(app, button);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            makeDraggable(button, {
                iconSize: PINNED_ICON_SIZE,
                payload: { kind: 'app', appId: id, gicon, name },
                delegate: this._pinnedStrip.delegate(),
                onDragBegin: () => { this._pinnedDragActive = true; getTooltip().hide(); },
                onDragEnd: () => {
                    this._pinnedDragActive = false;
                    this._ghost.clear();
                    getTooltip().hide();
                },
            });

            this._pinnedBarBox.add_child(button);

            if (id === this._justDroppedAppId) {
                this._justDroppedAppId = null;
                settleIcon(button);
            }
        }
    }

    _dropPinned(source, index, actor) {
        const appId = source?._dragPayload?.appId;
        if (!appId) return false;

        this._pinnedDragActive = false;
        const pos = index ?? this._pinnedBarBox.get_children().length;
        this._justDroppedAppId = appId;

        try { this._favorites.moveFavoriteToPos(appId, pos); }
        catch (e) { journal(`[AppSearchOverlay] Reorder failed: ${e.message}`); }

        if (actor) { actor.get_parent()?.remove_child(actor); actor.destroy(); }
        return true;
    }

    _openContextMenuForApp(app, sourceActor) {
        this._closeContextMenu();
        if (!this._menuManager)
            this._menuManager = new PopupMenu.PopupMenuManager(sourceActor);

        const menu = new AppMenu(sourceActor, St.Side.BOTTOM, { favoritesSection: true, showSingleWindows: true });
        Main.layoutManager.addChrome(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);
        menu.setApp(app);
        this._openMenu = menu;

        // Closing the whole overlay on any focus change is already the base
        // class's behavior — clicking a window item in this menu changes
        // window focus, so the overlay cleans itself up. No special arming
        // needed here.
        menu.connect('open-state-changed', (o, isOpen) => {
            if (isOpen) return;
            if (menu === this._openMenu) this._openMenu = null;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!menu.is_destroyed) menu.destroy();
                return GLib.SOURCE_REMOVE;
            });
        });
        menu.open(true);
    }

    _closeContextMenu() {
        if (this._openMenu) {
            try { this._openMenu.close(); } catch (e) { }
            this._openMenu = null;
        }
    }

    _onBeforeClose() {
        this._closeContextMenu();
        this._ghost.clear();
        this._pinnedScope.dispose();
        getTooltip().hide();
        this._allItemsCache = null;
    }

    _close() {
        if (this._closed) return;
        super._close();
    }

    _onFavoritesChanged() {
        if (this._closed) return;
        this._allItemsCache = null;
        this._renderPinnedBar();
        this._onSearchChanged();
    }

    _onSearchChanged() {
        if (this._closed) return;
        const query = this._entry.get_text().trim();
        const all = this._getAllResultsSorted();
        this._setResults(query ? this._searchApps(query, all) : all);
    }

    _searchApps(query, allItems) {
        const appSystem = Shell.AppSystem.get_default();
        const usage = Shell.AppUsage.get_default();

        let groups;
        try {
            if (typeof Shell.AppSystem.search === 'function') groups = Shell.AppSystem.search(query);
            else if (appSystem && typeof appSystem.search === 'function') groups = appSystem.search(query);
            else { journal('[AppSearchOverlay] Shell.AppSystem.search is unavailable'); return []; }
        } catch (e) {
            journal(`[AppSearchOverlay] Shell.AppSystem.search() threw: ${e.message}`);
            return [];
        }
        if (!groups || groups.length === 0) return [];

        const itemByApp = new Map();
        for (const item of allItems)
            if (item.app) itemByApp.set(item.app, item);

        const results = [];
        for (const group of groups) {
            if (!group || group.length === 0) continue;
            const resolved = [];
            for (const id of group) {
                let app;
                try { app = appSystem.lookup_app(id); } catch (e) { app = null; }
                if (!app) continue;
                const item = itemByApp.get(app);
                if (item) resolved.push({ id, item });
            }
            if (resolved.length === 0) continue;
            try { resolved.sort((a, b) => usage.compare(a.id, b.id)); }
            catch (e) { /* keep GLib's ordering */ }
            for (const { item } of resolved) results.push(item);
        }
        return results;
    }

    _buildResultRow(item, index) {
        return createResultRow({
            icon: item.icon,
            label: item.name,
            iconSize: this._settings.get_int('collection-result-icon-size'),
            fontSize: this._settings.get_int('collection-result-font-size'),
            pinned: item.pinned,
        });
    }

    _updatePreviewContent(item) {
        const built = createAppPreview(item, this._settings, this._previewBox.width);
        const isFav = this._favorites.isFavorite(item.app.get_id());
        built.pinButton.set_label(isFav ? 'Unpin from favorites (Ctrl+P)' : 'Pin to favorites (Ctrl+P)');

        this._previewScope.connect(built.pinButton, 'clicked', () => this._togglePin(item));
        for (const { button, action } of built.actions) {
            this._previewScope.connect(button, 'clicked', () => {
                item.app.launch_action(action, 0, -1);
                this._close();
            });
        }
        this._previewBox.add_child(built.actor);
        this._previewContent = built.actor;
    }

    _togglePin(item) {
        if (this._closed) return;
        const id = item.app.get_id();
        if (this._favorites.isFavorite(id)) this._favorites.removeFavorite(id);
        else this._favorites.addFavorite(id);
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (!item) return;
        this._launchApp(item.app);
        this._close();
    }
}