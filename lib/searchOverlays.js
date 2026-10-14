import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';

import {
    DragMotionResult, FloatingTooltip, computeInsertion, createClonePreviewActor,
    createGhostIcon, createReorderDraggable, getWindowAppIcon, makeWindowDraggable,
} from './ui.js';
import { WindowTracker } from './shellGlobals.js';
import { settleIcon } from './animationHelpers.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== FUZZY MATCHING ====================
// Token-based: every whitespace-separated token must appear (substring,
// falling back to fuzzy subsequence) somewhere in the text.
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

// ==================== SHARED OVERLAY BASE ====================
export class SearchOverlayBase {
    static _current = null;

    // Self-clears once an overlay has marked itself closed (covers both
    // _close() and the drag teardown that sets _closed directly).
    static get current() {
        if (SearchOverlayBase._current?._closed)
            SearchOverlayBase._current = null;
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
        this._resultButtons = [];
        this._selectedIndex = -1;
        this._previewContent = null;
        this._modalGrab = null;
        this._closed = false;
    }

    // ---- Hooks subclasses MUST implement ----
    _getHintText() { return 'Search…'; }
    _getAllResultsSorted() { return []; }
    _getSearchLabel(item) { return item.name ?? ''; }
    _buildResultRow(item, index) { throw new Error('_buildResultRow must be implemented'); }
    _updatePreviewContent(item) { }
    _activateResult(index) { }

    // ---- Hooks subclasses MAY override ----
    _getRestoreKey(item) { return null; }
    _onBeforeClose() { }
    _onFocusWindowChanged() { }
    _handleExtraKeys(event, symbol) { return undefined; }

    _computeLayout(monitor) {
        const margin = 40, entryHeight = 80, entryGap = 20;
        const panelWidth = monitor.width - margin * 2;
        const panelX = monitor.x + margin;
        const entryY = monitor.y + margin;
        const panelTop = entryY + entryHeight + entryGap;
        const panelHeight = monitor.height - (panelTop - monitor.y) - margin;
        const resultsWidth = Math.round(panelWidth * 0.32);
        const previewWidth = panelWidth - resultsWidth - 20;
        return { monitor, margin, entryHeight, entryGap, panelWidth, panelX, entryY, panelTop, panelHeight, resultsWidth, previewWidth };
    }

    _buildContainer(monitor) {
        this._container = new St.Widget({
            style_class: 'window-collection-overlay',
            reactive: true, can_focus: true,
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
        });
    }

    _buildEntry(layout) {
        this._entry = new St.Entry({
            style_class: 'collection-search-entry',
            hint_text: this._getHintText(),
            can_focus: true,
            x: layout.panelX, y: layout.entryY, width: layout.panelWidth, height: layout.entryHeight,
        });
        this._entry.set_style(`font-size: ${this._settings.get_int('collection-search-font-size')}pt;`);
        this._entryChangedId = this._entry.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this._entryKeyPressId = this._entry.clutter_text.connect('key-press-event',
            (actor, event) => this._onKeyPress(event));
    }

    _buildResultsAndPreview(layout, { previewVertical = false } = {}) {
        this._resultsScroll = new St.ScrollView({
            style_class: 'collection-results-scroll',
            x: layout.panelX, y: layout.panelTop, width: layout.resultsWidth, height: layout.panelHeight,
        });
        this._resultsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        this._resultsBox = new St.BoxLayout({ style_class: 'collection-results-box', vertical: true, x_expand: true });
        this._resultsScroll.set_child(this._resultsBox);

        this._previewBox = new St.BoxLayout({
            style_class: 'collection-preview-box',
            vertical: previewVertical,
            x: layout.panelX + layout.resultsWidth + 20, y: layout.panelTop,
            width: layout.previewWidth, height: layout.panelHeight,
        });
    }

    // -------------------- Lifecycle --------------------
    _open() {
        Main.layoutManager.addChrome(this._container, { affectsInputRegion: true, trackFullscreen: true });
        Main.layoutManager.uiGroup.set_child_above_sibling(this._container, null);
        this._modalGrab = Main.pushModal(this._container, { actionMode: Shell.ActionMode.NORMAL });
        this._entry.grab_key_focus();
        SearchOverlayBase._current = this;

        // Mutter's workspace-activate focus restoration can fire AFTER our
        // grab and steal key focus back to a window; reclaim it whenever
        // the focused window changes while we're open.
        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            if (this._closed) return;
            this._entry.grab_key_focus();
            this._onFocusWindowChanged();
        });
    }

    _close() {
        if (this._closed) return;
        this._closed = true;
        this._clearPreview();
        this._onBeforeClose();

        if (this._focusWindowId) { global.display.disconnect(this._focusWindowId); this._focusWindowId = null; }
        if (this._modalGrab) { Main.popModal(this._modalGrab); this._modalGrab = null; }
        if (this._entry?.clutter_text) {
            this._entry.clutter_text.disconnect(this._entryChangedId);
            this._entry.clutter_text.disconnect(this._entryKeyPressId);
        }
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
    }

    // -------------------- Search / results --------------------
    _onSearchChanged() {
        if (this._closed) return;
        const query = this._entry.get_text();
        const all = this._getAllResultsSorted();
        if (!query.trim()) { this._setResults(all); return; }
        const scored = [];
        for (const item of all) {
            const result = fuzzyMatch(query, this._getSearchLabel(item));
            if (result.matched) scored.push({ ...item, score: result.score });
        }
        scored.sort((a, b) => b.score - a.score);
        this._setResults(scored);
    }

    _setResults(results) {
        const previousKey = this._selectedIndex >= 0
            ? this._getRestoreKey(this._results[this._selectedIndex])
            : null;

        this._results = results;
        this._resultsBox.destroy_all_children();
        this._resultButtons = [];
        this._selectedIndex = -1;

        results.forEach((item, index) => {
            const button = this._buildResultRow(item, index);
            button.connect('clicked', () => this._activateResult(index));
            button.connect('notify::hover', () => { if (button.hover) this._selectIndex(index); });
            this._resultsBox.add_child(button);
            this._resultButtons.push(button);
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
        if (this._selectedIndex >= 0 && this._resultButtons[this._selectedIndex])
            this._resultButtons[this._selectedIndex].remove_style_class_name('selected');
        this._selectedIndex = index;
        this._resultButtons[index]?.add_style_class_name('selected');
        this._updatePreview(this._results[index]);
    }

    _updatePreview(item) { this._clearPreview(); this._updatePreviewContent(item); }

    _clearPreview() {
        if (!this._previewContent) return;
        if (this._previewContent.get_parent() === this._previewBox)
            this._previewBox.remove_child(this._previewContent);
        this._previewContent.destroy();
        this._previewContent = null;
    }

    // -------------------- Keyboard --------------------
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

// ==================== WINDOW SEARCH OVERLAY ====================
const NEMO_WM_CLASS = 'Nemo';
const FILE_PROGRESS_INSTANCE = 'file_progress';

export class WindowSearchOverlay extends SearchOverlayBase {
    constructor(windows, settings, focusedWindow = null) {
        super(settings);
        journal(`[WindowSearchOverlay] Opening with ${windows.length} windows`);
        this._windows = windows;
        this._focusedWindow = focusedWindow ?? global.display.focus_window;
        this._buildUI();
        this._setResults(this._getAllResultsSorted());
        this._open();
    }

    _getHintText() { return 'Search windows…'; }
    _getSearchLabel(item) { return `${item.title} — ${item.appName}`; }

    _getAppName(window) {
        const app = WindowTracker.get_window_app(window);
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

        // Move-to-front for the focused window.
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
        const button = new St.Button({
            style_class: 'collection-result-item',
            x_expand: true, x_align: Clutter.ActorAlign.START, track_hover: true, reactive: true,
        });
        button.set_style(`font-size: ${this._settings.get_int('collection-result-font-size')}pt;`);
        if (item.window === this._focusedWindow)
            button.add_style_class_name('collection-result-item-focused');

        const row = new St.BoxLayout({ vertical: false, x_expand: true });
        if (item.icon) {
            row.add_child(new St.Icon({
                gicon: item.icon,
                style_class: 'collection-result-icon',
                icon_size: this._settings.get_int('collection-result-icon-size'),
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        row.add_child(new St.Label({
            text: `${item.title}  —  ${item.appName}`,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        }));
        button.set_child(row);

        // Same drag path as indicator icons: the indicator sees drag.window
        // and its thumbnails accept the drop.
        const draggable = makeWindowDraggable(button, item.window, this._settings.get_int('icon-size'));
        button._draggable = draggable;
        draggable.connect('drag-begin', () => this._onResultDragBegin(button));
        return button;
    }

    _updateFocusedHighlight() {
        this._results.forEach((item, index) => {
            const button = this._resultButtons[index];
            if (!button) return;
            if (item.window === this._focusedWindow) button.add_style_class_name('collection-result-item-focused');
            else button.remove_style_class_name('collection-result-item-focused');
        });
    }

    // Only adopt the live focus-window if it's one of OUR windows —
    // transient nulls / windows on other workspaces would otherwise
    // wrongly clear a correct initial highlight.
    _onFocusWindowChanged() {
        if (this._closed) return;
        const liveFocus = global.display.focus_window;
        if (!liveFocus) return;
        if (!this._results.some(item => item.window === liveFocus)) return;
        this._focusedWindow = liveFocus;
        this._updateFocusedHighlight();
    }

    _updatePreviewContent(item) {
        const window = item.window;
        const windowFrame = window.get_frame_rect();
        if (windowFrame.height === 0) return;

        const aspect = windowFrame.width / windowFrame.height;
        let targetHeight = this._previewBox.height;
        let targetWidth = targetHeight * aspect;
        if (targetWidth > this._previewBox.width) {
            targetWidth = this._previewBox.width;
            targetHeight = targetWidth / aspect;
        }

        const built = createClonePreviewActor(window, targetHeight, {
            onClose: win => this._closeWindowFromPreview(win),
            closeButtonSize: this._settings.get_int('close-button-size'),
        });
        if (!built) return;

        built.actor.set_position(
            Math.max(0, (this._previewBox.width - built.width) / 2),
            Math.max(0, (this._previewBox.height - built.height) / 2));
        this._previewBox.add_child(built.actor);
        this._previewContent = built.actor;
    }

    _closeWindowFromPreview(window) {
        if (this._closed) return;
        journal(`[WindowSearchOverlay] Closing window from preview: ${window.title}`);
        window.delete(global.get_current_time());

        const closedIndex = this._results.findIndex(item => item.window === window);
        if (closedIndex === -1) return;

        this._results.splice(closedIndex, 1);
        this._windows = this._windows.filter(w => w !== window);

        const button = this._resultButtons[closedIndex];
        if (button) {
            if (button.get_parent() === this._resultsBox) this._resultsBox.remove_child(button);
            button.destroy();
        }
        this._resultButtons.splice(closedIndex, 1);

        if (this._results.length === 0) {
            this._selectedIndex = -1;
            this._clearPreview();
            return;
        }
        this._selectedIndex = -1;
        this._selectIndex(Math.min(closedIndex, this._results.length - 1));
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (!item) return;
        const window = item.window;
        journal(`[WindowSearchOverlay] Activating: ${window.title}`);
        if (window.minimized) window.unminimize();
        window.get_workspace().activate_with_focus(window, global.get_current_time());
        this._close();
    }

    // -------------------- DnD lifecycle --------------------
    // Shell DND installs its own stage grab during drag-begin and releases
    // it at drag-end; popModal / destroy() synchronously from inside those
    // signals can leave the grab stuck (frozen cursor). So the overlay
    // hides itself on an idle after drag-begin and destroys its actor tree
    // on an idle after drag-end.
    _onResultDragBegin(button) {
        if (this._closed) return;
        this._closed = true;
        journal(`[WindowSearchOverlay] Drag started on result — closing overlay, drag continues`);

        const draggable = button._draggable;
        const destroyLater = () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._destroyContainerAfterDrag();
            return GLib.SOURCE_REMOVE;
        });
        if (draggable) {
            const endId = draggable.connect('drag-end', () => {
                draggable.disconnect(endId);
                destroyLater();
            });
        } else {
            destroyLater();
        }

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._teardownVisibleOverlay();
            return GLib.SOURCE_REMOVE;
        });
    }

    _teardownVisibleOverlay() {
        if (!this._container) return;
        this._clearPreview();
        if (this._modalGrab) { Main.popModal(this._modalGrab); this._modalGrab = null; }
        if (this._focusWindowId) { global.display.disconnect(this._focusWindowId); this._focusWindowId = null; }
        if (this._entry?.clutter_text) {
            if (this._entryChangedId) { this._entry.clutter_text.disconnect(this._entryChangedId); this._entryChangedId = null; }
            if (this._entryKeyPressId) { this._entry.clutter_text.disconnect(this._entryKeyPressId); this._entryKeyPressId = null; }
        }
        Main.layoutManager.removeChrome(this._container);
        this._container.hide();
    }

    _destroyContainerAfterDrag() {
        if (this._modalGrab) { Main.popModal(this._modalGrab); this._modalGrab = null; }
        if (this._container) { this._container.destroy(); this._container = null; }
    }
}

// ==================== APP SEARCH OVERLAY ====================
const PINNED_ICON_SIZE = 96;
const PINNED_BAR_HEIGHT = 120;

export class AppSearchOverlay extends SearchOverlayBase {
    constructor(settings) {
        super(settings);
        this._favorites = AppFavorites.getAppFavorites();
        this._menuManager = null;
        this._openMenu = null;

        // Pinned-bar drag state (the overlay is its own tiny surface; this
        // ghost is local to it and unrelated to the workspace indicator).
        this._pinnedGhost = null;
        this._pinnedGhostIndex = null;
        this._pinnedSnap = null;
        this._pinnedDragHint = null;
        this._pinnedDragActive = false;
        this._justDroppedAppId = null;

        // The alphabetical list is stable across keystrokes; only
        // installed-changed / favorites-changed invalidate it.
        this._allItemsCache = null;

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

    // -------------------- App enumeration --------------------
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

    // Cached. Callers must treat the returned array as read-only.
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

    // -------------------- UI --------------------
    _buildUI() {
        const layout = this._computeLayout(Main.layoutManager.primaryMonitor);
        const { monitor, margin, panelWidth, panelX, entryY } = layout;

        this._buildContainer(monitor);
        this._buildEntry(layout);
        this._buildResultsAndPreview(layout, { previewVertical: true });

        this._pinnedBarBox = new St.BoxLayout({
            style_class: 'dmenu-pinned-bar',
            vertical: false, x_expand: true, y_expand: false,
            height: PINNED_BAR_HEIGHT,
            x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        this._pinnedBarBox._delegate = this._pinnedBarBox;
        this._pinnedBarBox.handleDragOver = source => this._handlePinnedDragOver(source);
        this._pinnedBarBox.acceptDrop = (source, actor) => this._acceptPinnedDrop(source, actor);
        this._pinnedBarBox.hide();

        const mainVertical = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });

        const pinnedWrapper = new St.BoxLayout({ vertical: false, x_expand: true, y_expand: false, style: 'padding: 0 0 8px 0;' });
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

        this._favoritesChangedId = this._favorites.connect('changed', () => this._onFavoritesChanged());
        this._installedChangedId = Shell.AppSystem.get_default().connect('installed-changed', () => {
            this._allItemsCache = null;
        });

        this._renderPinnedBar();
    }

    // -------------------- Pinned bar --------------------
    _renderPinnedBar() {
        this._pinnedBarBox.destroy_all_children();
        const favorites = this._favorites.getFavorites();

        if (!favorites || favorites.length === 0) { this._pinnedBarBox.hide(); return; }
        this._pinnedBarBox.show();

        for (const app of favorites) {
            const icon = app.get_icon();
            if (!icon) continue;

            const id = app.get_id();
            const name = app.get_name?.() || '';

            const button = new St.Button({
                style_class: 'dmenu-pinned-icon',
                child: new St.Icon({ gicon: icon, icon_size: PINNED_ICON_SIZE }),
                reactive: true, can_focus: true, track_hover: true,
            });
            button._appId = id;
            button._appName = name;
            button._gicon = icon;

            const tooltip = new FloatingTooltip({
                parent: this._container,
                fontSize: this._settings.get_int('tooltip-font-size'),
            });
            button._tooltip = tooltip;

            button.connect('notify::hover', () => {
                if (this._pinnedDragActive || !button.hover) tooltip.hide();
                else tooltip.showBelow(button, name);
            });
            button.connect('destroy', () => tooltip.destroy());
            button.connect('clicked', () => { this._launchApp(app); this._close(); });
            button.connect('button-press-event', (actor, event) => {
                if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                    this._openContextMenuForApp(app, button);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            const draggable = createReorderDraggable(button, PINNED_ICON_SIZE);
            draggable.connect('drag-begin', () => {
                this._pinnedDragActive = true;
                button.add_style_class_name('reorder-drag-source');
                this._hideAllPinnedTooltips();
            });
            draggable.connect('drag-end', () => {
                this._pinnedDragActive = false;
                try { button.remove_style_class_name('reorder-drag-source'); }
                catch (e) { /* button may already be destroyed after a drop */ }
                this._clearPinnedGhost();
                this._pinnedDragHint?.hide();
            });
            button._draggable = draggable;

            button._delegate = button;
            button.handleDragOver = source => source._appId ? this._handlePinnedDragOver(source) : DragMotionResult.NO_DROP;
            button.acceptDrop = (source, actor) => source._appId ? this._acceptPinnedDrop(source, actor) : false;

            this._pinnedBarBox.add_child(button);

            if (id === this._justDroppedAppId) {
                this._justDroppedAppId = null;
                settleIcon(button);
            }
        }
    }

    _hideAllPinnedTooltips() {
        for (const b of this._pinnedBarBox.get_children()) b._tooltip?.hide();
    }

    _showPinnedGhost(index, source) {
        const box = this._pinnedBarBox;
        const clamped = Math.max(0, Math.min(index, box.get_children().length));
        if (this._pinnedGhost && this._pinnedGhostIndex === clamped) return;
        this._pinnedGhostIndex = clamped;
        if (!this._pinnedGhost)
            this._pinnedGhost = createGhostIcon(source._gicon, PINNED_ICON_SIZE);
        this._pinnedGhost.get_parent()?.remove_child(this._pinnedGhost);
        box.insert_child_at_index(this._pinnedGhost, clamped);
    }

    _clearPinnedGhost() {
        if (this._pinnedGhost) {
            this._pinnedGhost.get_parent()?.remove_child(this._pinnedGhost);
            this._pinnedGhost.destroy();
        }
        this._pinnedGhost = null;
        this._pinnedGhostIndex = null;
        this._pinnedSnap = null;
    }

    _handlePinnedDragOver(source) {
        if (!source._appId) return DragMotionResult.NO_DROP;

        const [pointerX] = global.get_pointer();

        // Snapshot once per drag so the ghost can't shift what we measure.
        if (!this._pinnedSnap) {
            this._pinnedSnap = this._pinnedBarBox.get_children()
                .filter(b => b._appId && b !== source && b.get_stage())
                .map(b => {
                    const [x] = b.get_transformed_position();
                    const [width] = b.get_transformed_size();
                    return { item: b, x, width, mid: x + width / 2, right: x + width };
                });
        }
        const insertion = computeInsertion(this._pinnedSnap, pointerX);
        this._showPinnedGhost(insertion.index, source);

        if (!this._pinnedDragHint)
            this._pinnedDragHint = new FloatingTooltip({
                parent: this._container,
                fontSize: this._settings.get_int('tooltip-font-size'),
            });

        let text = 'Pin here';
        if (insertion.neighbor) {
            const name = insertion.neighbor._appName ?? '';
            text = insertion.insertBefore ? `Move before ${name}` : `Move after ${name}`;
        }
        this._pinnedDragHint.showAbove(insertion.neighbor ?? this._pinnedBarBox, text);
        return DragMotionResult.MOVE_DROP;
    }

    _acceptPinnedDrop(source, actor) {
        if (!source._appId) return false;

        this._pinnedDragActive = false;
        const index = this._pinnedGhostIndex;
        this._clearPinnedGhost();
        this._pinnedDragHint?.hide();
        this._justDroppedAppId = source._appId;

        try {
            this._favorites.moveFavoriteToPos(source._appId, index ?? this._pinnedBarBox.get_children().length);
        } catch (e) {
            journal(`[AppSearchOverlay] Reorder failed: ${e.message}`);
        }

        if (actor) {
            actor.get_parent()?.remove_child(actor);
            actor.destroy();
        }
        return true;
    }

    _openContextMenuForApp(app, sourceActor) {
        this._closeContextMenu();
        if (!this._menuManager)
            this._menuManager = new PopupMenu.PopupMenuManager(sourceActor);

        const menu = new AppMenu(sourceActor, St.Side.BOTTOM, { favoritesSection: true, showSingleWindows: true });
        menu.actor.add_style_class_name('dmenu-context-menu');
        Main.layoutManager.addChrome(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);
        menu.setApp(app);
        this._openMenu = menu;

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

    // -------------------- Lifecycle --------------------
    _onBeforeClose() {
        this._closeContextMenu();
        this._clearPinnedGhost();
        this._pinnedDragHint?.destroy();
        this._pinnedDragHint = null;

        if (this._favoritesChangedId) { this._favorites.disconnect(this._favoritesChangedId); this._favoritesChangedId = null; }
        if (this._installedChangedId) {
            try { Shell.AppSystem.get_default().disconnect(this._installedChangedId); } catch (e) { }
            this._installedChangedId = null;
        }
        this._allItemsCache = null;
    }

    _close() {
        if (this._closed) return;
        super._close();
    }

    _onFavoritesChanged() {
        if (this._closed) return;
        this._allItemsCache = null; // cached `pinned` flags are stale now
        this._renderPinnedBar();
        this._onSearchChanged();
    }

    // -------------------- Search --------------------
    // Mirrors GNOME's AppSearchProvider: Shell.AppSystem.search() (GLib's
    // indexed matcher), each equal-score group sorted by Shell.AppUsage.
    // No result cap. Empty query → full alphabetical list.
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

        // Index by Shell.App identity (lookup_app returns canonical instances).
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

    // -------------------- Results rendering --------------------
    _buildResultRow(item, index) {
        const button = new St.Button({
            style_class: 'collection-result-item',
            x_expand: true, x_align: Clutter.ActorAlign.START, track_hover: true, reactive: true,
        });
        button.set_style(`font-size: ${this._settings.get_int('collection-result-font-size')}pt;`);

        const row = new St.BoxLayout({ vertical: false, x_expand: true });
        if (item.icon) {
            row.add_child(new St.Icon({
                gicon: item.icon,
                style_class: 'collection-result-icon',
                icon_size: this._settings.get_int('collection-result-icon-size'),
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        row.add_child(new St.Label({ text: item.name, x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        if (item.pinned) {
            row.add_child(new St.Label({ text: '📌', style_class: 'app-pin-marker', y_align: Clutter.ActorAlign.CENTER }));
        }
        button.set_child(row);
        return button;
    }

    _updatePreviewContent(item) {
        const { app } = item;

        const wrapper = new St.BoxLayout({
            vertical: true, x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });

        wrapper.add_child(new St.Icon({
            gicon: item.icon,
            icon_size: this._settings.get_int('app-preview-icon-size') || 128,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        wrapper.add_child(new St.Label({
            text: item.name, style_class: 'clone-title-overlay', x_align: Clutter.ActorAlign.CENTER,
        }));

        const appInfo = app.get_app_info?.();
        const description = appInfo?.get_description?.();
        if (description) {
            const descLabel = new St.Label({
                text: description, style_class: 'app-description-label', x_align: Clutter.ActorAlign.CENTER,
            });
            descLabel.clutter_text.set_line_wrap(true);
            descLabel.clutter_text.set_width(this._previewBox.width - 80);
            wrapper.add_child(descLabel);
        }

        const isFav = this._favorites.isFavorite(app.get_id());
        const pinButton = new St.Button({
            style_class: 'app-preview-pin-button',
            label: isFav ? 'Unpin from favorites (Ctrl+P)' : 'Pin to favorites (Ctrl+P)',
            can_focus: true,
        });
        pinButton.connect('clicked', () => this._togglePin(item));
        wrapper.add_child(pinButton);

        const actions = appInfo?.list_actions?.();
        if (actions && actions.length > 0) {
            const actionsBox = new St.BoxLayout({ vertical: true, x_align: Clutter.ActorAlign.CENTER });
            for (const action of actions) {
                const actionButton = new St.Button({
                    style_class: 'app-preview-action-button',
                    label: appInfo.get_action_name(action),
                    can_focus: true,
                });
                actionButton.connect('clicked', () => { app.launch_action(action, 0, -1); this._close(); });
                actionsBox.add_child(actionButton);
            }
            wrapper.add_child(actionsBox);
        }

        this._previewBox.add_child(wrapper);
        this._previewContent = wrapper;
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
