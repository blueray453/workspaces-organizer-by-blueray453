import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';

import { Scope } from './scheduling.js';
import { Display, WorkspaceManager } from './model.js';
import {
    createReorderGhost, createDropStrip, DragMotionResult,
    makeDraggable, getTooltip, settleIcon,
} from './interactions.js';
import {
    getWindowAppIcon, createFullscreenContainer, createSearchField,
    computeLauncherLayout, createSectionHeading, createDividerHeading,
    createPinnedRow, createGridScroll, createAppTile,
    computeSelectorLayout, createWindowTitleRow, createSelectionBand,
    createFadeEdge, createSelectorHint,
} from './ui.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ==================== fuzzy matching ====================
// Order of attempts per token: substring > subsequence > typo-tolerant word-prefix.
// Returns the matched character offsets so callers can bold them.
function subsequenceMatch(token, text) {
    const positions = [];
    let qi = 0, score = 0, consecutive = 0;
    for (let ti = 0; ti < text.length && qi < token.length; ti++) {
        if (text[ti] === token[qi]) { score += 1 + consecutive; consecutive++; qi++; positions.push(ti); }
        else consecutive = 0;
    }
    return qi < token.length ? { matched: false } : { matched: true, score, positions };
}

// Optimal-string-alignment distance (insert / delete / substitute / transpose).
function osaDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}

function typoMatch(token, text) {
    if (token.length < 4) return null;
    const limit = token.length >= 6 ? 2 : 1;
    for (const m of text.matchAll(/[^\s\-_.\/:—]+/g)) {
        const word = m[0];
        for (let len = token.length - 1; len <= token.length + 1; len++) {
            if (len < 1 || len > word.length) continue;
            if (osaDistance(token, word.slice(0, len)) <= limit) {
                const positions = [];
                for (let i = 0; i < word.length; i++) positions.push(m.index + i);
                return { score: 10, positions };
            }
        }
    }
    return null;
}

function fuzzyMatch(query, text) {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const indices = new Set();
    if (tokens.length === 0) return { matched: true, score: 0, indices };

    const lower = text.toLowerCase();
    let score = 0;
    for (const token of tokens) {
        const idx = lower.indexOf(token);
        if (idx !== -1) {
            const boundary = idx === 0 || /[\s\-_.\/]/.test(lower[idx - 1]);
            score += 60 - Math.min(idx, 40) + (boundary ? 20 : 0);
            for (let i = idx; i < idx + token.length; i++) indices.add(i);
            continue;
        }
        const sub = subsequenceMatch(token, lower);
        if (sub.matched) { score += sub.score; sub.positions.forEach(p => indices.add(p)); continue; }
        const typo = typoMatch(token, lower);
        if (!typo) return { matched: false, score: -1, indices: new Set() };
        score += typo.score;
        typo.positions.forEach(p => indices.add(p));
    }
    return { matched: true, score, indices };
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
        this._selectedIndex = -1;
        this._query = '';
        this._modalGrab = null;
        this._closed = false;
        this._focusGuard = false;

        this._scope = new Scope();
        this._rowsScope = new Scope();
    }

    // ---- hooks ----
    _trackFullscreen() { return true; }
    _getAllResultsSorted() { return []; }
    _matchItem(query, item) { return fuzzyMatch(query, item.name ?? ''); }
    _computeResults(query) {
        const all = this._getAllResultsSorted();
        if (!query) return all.map(item => ({ ...item, indices: null }));
        const scored = [];
        for (const item of all) {
            const r = this._matchItem(query, item);
            if (r.matched) scored.push({ ...item, score: r.score, indices: r.indices });
        }
        return scored.sort((a, b) => b.score - a.score);
    }
    _beforeResults(query, unchanged) { }
    _renderResults(results) { }
    _onSelectionChanged(index) { }
    _getRestoreKey(item) { return null; }
    _activateResult(index) { }
    _activateFocused() { if (this._selectedIndex >= 0) this._activateResult(this._selectedIndex); }
    _initialKeyFocus() { this._entry.grab_key_focus(); }
    _handleEscape() { this._close(); }
    _handleExtraKeys(event, symbol) { return undefined; }
    _onBeforeClose() { }
    _shouldCloseOnWindowRemoved(window) { return true; }

    _wireEntry(entry) {
        this._entry = entry;
        this._scope.connect(entry.clutter_text, 'text-changed', () => this._onSearchChanged());
        this._scope.connect(entry.clutter_text, 'key-press-event', (a, e) => this._onKeyPress(e));
    }

    _open() {
        Main.layoutManager.addChrome(this._container, {
            affectsInputRegion: true, trackFullscreen: this._trackFullscreen(),
        });
        Main.layoutManager.uiGroup.set_child_above_sibling(this._container, null);
        this._modalGrab = Main.pushModal(this._container, { actionMode: Shell.ActionMode.NORMAL });
        this._initialKeyFocus();
        SearchOverlayBase._current = this;

        // Keys not consumed by the entry (or pressed while the container has focus) land here.
        this._scope.connect(this._container, 'key-press-event', (a, e) => this._onKeyPress(e));

        // The overlay is a snapshot: any change to the world closes it.
        // `_focusGuard` lets a subclass change focus itself without closing.
        this._scope.connect(Display, 'notify::focus-window', () => {
            if (this._closed || this._focusGuard) return;
            this._close();
        });
        this._scope.connect(Display, 'window-created', () => { if (!this._closed) this._close(); });
        this._scope.connect(Display, 'window-removed', (display, window) => {
            if (this._closed || !this._shouldCloseOnWindowRemoved(window)) return;
            this._close();
        });
    }

    _close() {
        if (this._closed) return;
        this._closed = true;
        getTooltip().hide();
        this._onBeforeClose();

        if (this._modalGrab) { Main.popModal(this._modalGrab); this._modalGrab = null; }
        this._rowsScope.dispose();
        this._scope.dispose();

        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
    }

    _onSearchChanged() {
        if (this._closed) return;
        const query = this._entry.get_text().trim();
        const unchanged = query === this._query;
        this._query = query;
        this._beforeResults(query, unchanged);
        this._setResults(this._computeResults(query), unchanged);
    }

    // keepSelection: same query (e.g. a pin toggled) -> keep the selected item; new query -> top hit.
    _setResults(results, keepSelection = true) {
        const prev = this._results[this._selectedIndex];
        const previousKey = keepSelection && prev ? this._getRestoreKey(prev) : null;

        this._results = results;
        this._rowsScope.dispose();
        this._rowsScope = new Scope();
        this._selectedIndex = -1;
        this._renderResults(results);

        if (results.length === 0) { this._onSelectionChanged(-1); return; }
        const restored = previousKey !== null
            ? results.findIndex(item => this._getRestoreKey(item) === previousKey) : -1;
        this._selectIndex(restored >= 0 ? restored : 0);
    }

    _selectIndex(index) {
        if (this._closed || index < 0 || index >= this._results.length) return;
        this._selectedIndex = index;
        this._onSelectionChanged(index);
    }

    _onKeyPress(event) {
        if (this._closed) return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        const handled = this._handleExtraKeys(event, symbol);
        if (handled !== undefined) return handled;

        switch (symbol) {
            case Clutter.KEY_Escape:
                this._handleEscape();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                this._selectIndex(this._selectedIndex + 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
                this._selectIndex(this._selectedIndex - 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
                this._activateFocused();
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }
}

// ==================== window selector (all windows AND the 5+ windows workspace overlay) ====================
const NEMO_WM_CLASS = 'Nemo';
const FILE_PROGRESS_INSTANCE = 'file_progress';

export class WindowSearchOverlay extends SearchOverlayBase {
    constructor(windows, settings, focusedWindow = null) {
        super(settings);
        journal(`[WindowSearchOverlay] Opening with ${windows.length} windows`);
        this._windows = windows;                       // immutable snapshot
        this._focusedWindow = focusedWindow ?? Display.focus_window;
        this._pendingDeletions = new Set();
        this._allItemsCache = null;

        this._rows = [];
        this._scrollAccum = 0;
        this._scrollPos = 0;        // continuous, eased
        this._scrollTarget = 0;     // selected index
        this._tweenId = 0;
        this._lastFrame = 0;
        this._lastScrollStep = 0;   // throttle: one step per physical scroll action
        this._snap = true;          // place rows instantly after a new result list

        this._origin = { window: Display.focus_window, workspace: WorkspaceManager.get_active_workspace() };
        this._revealed = null;      // window currently shown behind the overlay
        this._revealedAny = false;
        this._maximizedWindow = null;   // window WE maximized (to undo later)
        this._revealTimer = 0;
        this._guardTimer = 0;
        this._cancelled = false;

        this._buildUI();
        this._onSearchChanged();
        this._open();
    }

    // Fullscreen windows hide chrome tracked with trackFullscreen; we must stay visible over them.
    _trackFullscreen() { return false; }

    _shouldCloseOnWindowRemoved(window) {
        if (this._pendingDeletions.has(window)) { this._pendingDeletions.delete(window); return false; }
        return true;
    }

    _getRestoreKey(item) { return item.window; }

    // Match against "title appName"; only offsets inside the title are bolded.
    _matchItem(query, item) {
        const r = fuzzyMatch(query, `${item.title} ${item.appName}`);
        if (!r.matched) return r;
        return { ...r, indices: new Set([...r.indices].filter(i => i < item.title.length)) };
    }

    _getAppName(window) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        return app ? app.get_name() : (window.get_wm_class() || 'Unknown');
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
                this._pendingDeletions.add(existing);
                existing.delete(0);
                keptByTitle.set(key, w);
                result.push(w);
            } else {
                journal(`[WindowSearchOverlay] Closing duplicate Nemo window: "${w.get_title()}"`);
                this._pendingDeletions.add(w);
                w.delete(0);
            }
        }
        return result;
    }

    _getAllResultsSorted() {
        if (this._allItemsCache) return this._allItemsCache;   // cached: dedupe must only delete once
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
        return (this._allItemsCache = items);
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        const L = this._layout = computeSelectorLayout(monitor);
        this._monitor = monitor;
        this._container = createFullscreenContainer(monitor, 'window-selector-overlay');
        this._container.add_style_class_name('search-mode');

        const size = { width: L.monitorWidth, height: L.monitorHeight };
        this._tint = new St.Widget({ style_class: 'selector-tint', reactive: false, opacity: 255, ...size });
        this._listLayer = new St.Widget(size);

        const { band, titleBin } = createSelectionBand(L);
        this._bandBin = titleBin;
        const search = createSearchField({ width: L.searchWidth, hint: 'Search windows…' });
        this._wireEntry(search.entry);
        this._searchRoot = search.actor;
        band.add_child(new St.Bin({ x_expand: true, x_align: Clutter.ActorAlign.CENTER, child: search.actor }));

        for (const actor of [
            this._tint, this._listLayer,
            createFadeEdge(L, true), createFadeEdge(L, false),
            band, createSelectorHint(L),
        ]) this._container.add_child(actor);

        this._scope.connect(this._container, 'scroll-event', (a, e) => this._onScroll(e));
        this._scope.connect(this._container, 'button-release-event', (a, e) => this._onClick(e));

        // Belt-and-braces: whenever the stage's key focus leaves the search
        // entry, pull it back. Guards against anything that changes focus
        // outside of _revealWindow — notifications, the shell's own window
        // tracking, etc.
        this._scope.connect(global.stage, 'notify::key-focus', () => {
            if (this._closed) return;
            if (global.stage.get_key_focus() === this._entry.clutter_text) return;
            this._refocusEntry();
        });
    }

    _renderResults(results) {
        const L = this._layout;
        this._listLayer.destroy_all_children();
        this._rows = results.map(item => {
            const row = createWindowTitleRow({
                icon: item.icon, title: item.title, indices: item.indices,
                width: L.monitorWidth, height: L.rowHeight, iconSize: L.iconSize,
            });
            this._listLayer.add_child(row);
            return row;
        });
        this._snap = true;
    }

    _onSelectionChanged(index) {
        if (index < 0) {
            this._bandBin.set_child(null);
            this._cancelReveal();
            return;
        }
        const item = this._results[index];
        const L = this._layout;
        this._bandBin.set_child(createWindowTitleRow({
            icon: item.icon, title: item.title, indices: item.indices,
            width: L.monitorWidth, height: L.selectedHeight, iconSize: L.selectedIconSize, selected: true,
        }));

        this._scrollTarget = index;
        if (this._snap) { this._scrollPos = index; this._layoutRows(); this._snap = false; }
        else this._startTween();

        this._scheduleReveal(item);
    }

    // ---- smooth scrolling ----
    _startTween() {
        if (this._tweenId) return;
        this._lastFrame = GLib.get_monotonic_time() / 1000;
        this._tweenId = this._scope.timeout(16, () => {
            const now = GLib.get_monotonic_time() / 1000;
            const dt = Math.min(now - this._lastFrame, 50);
            this._lastFrame = now;
            const diff = this._scrollTarget - this._scrollPos;
            if (Math.abs(diff) < 0.002) {
                this._scrollPos = this._scrollTarget;
                this._layoutRows();
                this._tweenId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._scrollPos += diff * (1 - Math.exp(-dt / 70));   // exponential ease-out, frame-rate independent
            this._layoutRows();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Row i sits at distance d = i - pos from the band. d <= -1 stacks upward from the band's top edge,
    // d >= 1 stacks downward from its bottom edge, and in between rows glide behind the opaque band.
    _layoutRows() {
        const L = this._layout, pos = this._scrollPos;
        const a = L.bandTop - L.rowHeight / 2;                         // centre at d = -1
        const b = L.bandTop + L.bandHeight + L.rowHeight / 2;          // centre at d = +1
        const mid = (a + b) / 2, half = (b - a) / 2;
        this._rows.forEach((row, i) => {
            const d = i - pos;
            let c;
            if (d <= -1) c = a + (d + 1) * L.rowHeight;
            else if (d >= 1) c = b + (d - 1) * L.rowHeight;
            else c = mid + d * half;
            row.visible = c + L.rowHeight / 2 > 0 && c - L.rowHeight / 2 < L.monitorHeight;
            if (row.visible) row.set_position(0, Math.round(c - L.rowHeight / 2));
        });
    }

    // One step per physical scroll action. Devices differ in how many SMOOTH
    // events they emit per wheel notch (some send two, each with delta ≈ 1);
    // a short throttle collapses those bursts into a single step so the
    // selection never jumps by two. The tween makes the motion look fluid.
    _onScroll(event) {
        let step = 0;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP) step = -1;
        else if (dir === Clutter.ScrollDirection.DOWN) step = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            this._scrollAccum += dy;
            if (Math.abs(this._scrollAccum) >= 1) {
                step = Math.sign(this._scrollAccum);
                this._scrollAccum = 0;
            }
        }
        if (!step) return Clutter.EVENT_STOP;

        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastScrollStep < 50) return Clutter.EVENT_STOP;
        this._lastScrollStep = now;

        this._selectIndex(clamp(this._selectedIndex + step, 0, this._results.length - 1));
        return Clutter.EVENT_STOP;
    }

    // Rolling guard: activating/maximizing windows changes focus, which would otherwise close us.
    _guardFocus(ms = 1200) {
        this._focusGuard = true;
        if (this._guardTimer) this._scope.cancel(this._guardTimer);
        this._guardTimer = this._scope.timeout(ms, () => {
            this._guardTimer = 0;
            this._focusGuard = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleReveal(item) {
        this._cancelReveal();
        this._revealTimer = this._scope.timeout(120, () => {
            this._revealTimer = 0;
            this._revealWindow(item.window);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelReveal() {
        if (!this._revealTimer) return;
        this._scope.cancel(this._revealTimer);
        this._revealTimer = 0;
    }

    // Make the real window the background: unminimize, switch to its workspace, maximize it.
    _revealWindow(win) {
        if (this._closed || win === this._revealed) return;
        this._guardFocus();
        this._releaseRevealed();
        try {
            const time = global.get_current_time();
            if (win.minimized) win.unminimize();
            const alreadyMax = win.get_maximized() === Meta.MaximizeFlags.BOTH;
            if (!alreadyMax) { win.maximize(Meta.MaximizeFlags.BOTH); this._maximizedWindow = win; }
            const ws = win.get_workspace();
            if (ws) ws.activate_with_focus(win, time);
            else win.activate(time);
            this._revealed = win;
            this._revealedAny = true;
        } catch (e) {
            journal(`[WindowSearchOverlay] reveal failed: ${e.message}`, true);
        }
        // Activation hands keyboard focus to the real window. Pull it back
        // to the search entry so typing keeps going to the field.
        this._refocusEntry();
    }

    // Re-grab the search entry's keyboard focus on the next idle. Idle rather
    // than a direct call because window activation settles asynchronously;
    // grabbing immediately can race the shell's own focus assignment.
    _refocusEntry() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._closed) return GLib.SOURCE_REMOVE;
            this._entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Undo the maximize we applied (never touches windows that were already maximized).
    _releaseRevealed() {
        const win = this._maximizedWindow;
        this._maximizedWindow = null;
        if (!win) return;
        try { win.unmaximize(Meta.MaximizeFlags.BOTH); } catch (e) { /* window gone */ }
    }

    // Put the user back where they started (Escape).
    _restoreOrigin() {
        if (!this._revealedAny) return;
        this._revealedAny = false;
        this._guardFocus();
        const { window: win, workspace } = this._origin;
        const time = global.get_current_time();
        try {
            const ws = win?.get_workspace();
            if (ws) ws.activate_with_focus(win, time);
            else workspace?.activate(time);
        } catch (e) { /* window gone */ }
    }

    _handleEscape() {
        this._cancelled = true;
        this._close();
    }

    _onBeforeClose() {
        this._cancelReveal();
        this._releaseRevealed();
        if (this._cancelled) this._restoreOrigin();
    }

    _handleExtraKeys(event, symbol) {
        if (symbol === Clutter.KEY_Page_Down) { this._selectIndex(Math.min(this._selectedIndex + 5, this._results.length - 1)); return Clutter.EVENT_STOP; }
        if (symbol === Clutter.KEY_Page_Up) { this._selectIndex(Math.max(this._selectedIndex - 5, 0)); return Clutter.EVENT_STOP; }
        return undefined;
    }

    // Clicks inside the search field (padding included) focus the entry and
    // never activate. Clicks anywhere else activate the selected window.
    _onClick(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
        const src = event.get_source();
        if (src && this._searchRoot.contains(src)) {
            this._entry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        }
        this._activateFocused();
        return Clutter.EVENT_STOP;
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (!item) return;
        const window = item.window;
        this._cancelReveal();
        this._releaseRevealed();
        if (window.minimized) window.unminimize();
        window.get_workspace().activate_with_focus(window, global.get_current_time());
        this._close();
    }

    _close() {
        if (this._closed) return;
        journal('[WindowSearchOverlay] Closing');
        super._close();
    }
}

// ==================== app launcher ====================
const PINNED_ICON_SIZE = 112;

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

        this._zone = 'grid';             // 'pinned' | 'grid'
        this._pinnedIndex = 0;
        this._pinnedItems = [];
        this._pinnedButtons = [];
        this._buttons = [];
        this._focusedGridBtn = null;
        this._focusedPinnedBtn = null;
        this._searching = false;
        this._resetScroll = true;
        this._lastWheel = 0;
        this._scrollTarget = 0;
        this._pinnedTarget = 0;
        this._lastPinnedWheel = 0;
        this._pinnedLeft = null;
        this._pinnedRight = null;

        this._buildUI();
        this._onSearchChanged();
        this._zone = this._pinnedVisible() ? 'pinned' : 'grid';
        this._refreshFocus();
        this._open();
    }

    // Start in navigation mode (so '/' means "search"); typing a character also starts a search.
    _initialKeyFocus() { this._container.grab_key_focus(); }
    _entryFocused() { return global.stage.get_key_focus() === this._entry.clutter_text; }
    _focusSearch() { this._entry.grab_key_focus(); }

    _getRestoreKey(item) { return item.app.get_id(); }
    _pinnedVisible() { return this._pinnedSection.visible && this._pinnedButtons.length > 0; }

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

    // ---- search ----
    _computeResults(query) {
        const all = this._getAllResultsSorted();
        if (!query) return all.map(item => ({ ...item, indices: null }));

        const scored = [];
        for (const item of all) {
            const r = fuzzyMatch(query, item.name);
            if (r.matched) scored.push({ ...item, score: r.score, indices: r.indices });
        }
        scored.sort((a, b) => b.score - a.score);

        // Also include Shell's keyword/description hits that fuzzy name matching missed.
        const seen = new Set(scored.map(i => i.app.get_id()));
        for (const item of this._shellSearch(query, all)) {
            const id = item.app.get_id();
            if (seen.has(id)) continue;
            seen.add(id);
            scored.push({ ...item, score: 0, indices: null });
        }
        return scored;
    }

    _shellSearch(query, allItems) {
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

    _beforeResults(query, unchanged) {
        const searching = query.length > 0;
        if (searching && !this._searching) this._zone = 'grid';
        else if (!searching && this._searching) this._zone = this._pinnedItems.length ? 'pinned' : 'grid';
        this._searching = searching;
        this._resetScroll = !unchanged;
        this._syncSectionVisibility();
    }

    _syncSectionVisibility() {
        this._pinnedSection.visible = !this._searching && this._pinnedItems.length > 0;
        this._allHeadingLabel.set_text(this._searching ? 'RESULTS' : 'ALL APPS');
        if (!this._pinnedSection.visible && this._zone === 'pinned') this._zone = 'grid';
    }

    // ---- UI ----
    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        const L = this._layout = computeLauncherLayout(monitor);
        this._cols = L.columns;
        this._tileW = L.tileWidth;
        this._container = createFullscreenContainer(monitor, 'launcher-overlay');

        // Search area: top centre, visually separate from the panel.
        const search = createSearchField({
            width: L.searchWidth, hint: 'Search', keyHint: "Press '/' to search", x: L.searchX, y: L.searchY,
        });
        this._wireEntry(search.entry);
        this._container.add_child(search.actor);

        const panel = new St.BoxLayout({
            style_class: 'launcher-panel', vertical: true, clip_to_allocation: true,
            x: L.panelX, y: L.panelY, width: L.panelWidth, height: L.panelHeight,
        });

        // Pinned apps (stays above the scrolling grid).
        const pinned = createPinnedRow();
        this._pinnedBarBox = pinned.box;
        this._pinnedScroll = pinned.scroll;
        this._wirePinnedScroll(pinned);
        this._pinnedStrip = createDropStrip({
            container: this._pinnedBarBox, ghost: this._ghost,
            acceptSource: source => source?._dragPayload?.kind === 'app',
            externalResult: DragMotionResult.NO_DROP,
            hint: {
                show: (anchor, text) => getTooltip().showAbove(anchor, text, this._settings.get_int('tooltip-font-size')),
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

        this._pinnedSection = new St.BoxLayout({ style_class: 'launcher-pinned-section', vertical: true, x_expand: true });
        this._pinnedSection.add_child(createSectionHeading('PINNED APPS'));
        this._pinnedSection.add_child(pinned.actor);
        panel.add_child(this._pinnedSection);

        // All apps.
        const heading = createDividerHeading('ALL APPS');
        this._allHeadingLabel = heading.label;
        panel.add_child(heading.actor);

        const grid = createGridScroll();
        this._gridScroll = grid.scroll;
        this._gridBox = grid.box;
        panel.add_child(grid.scroll);
        this._container.add_child(panel);

        // Smooth, predictable wheel scrolling inside the panel.
        this._scope.connect(this._gridScroll, 'scroll-event', (a, e) => this._onGridScroll(e));
        // Clicks on empty overlay areas intentionally do nothing.

        this._scope.connect(this._favorites, 'changed', () => this._onFavoritesChanged());
        this._scope.connect(Shell.AppSystem.get_default(), 'installed-changed', () => { this._allItemsCache = null; });

        this._renderPinnedBar();
    }

    _wirePinnedScroll(pinned) {
        this._pinnedLeft = pinned.left;
        this._pinnedRight = pinned.right;
        const adj = pinned.scroll.hadjustment;
        const update = () => this._updatePinnedIndicators();
        this._scope.connect(adj, 'changed', update);
        this._scope.connect(adj, 'notify::value', update);
        this._scope.connect(pinned.left, 'clicked', () => this._easePinned(-adj.page_size * 0.8));
        this._scope.connect(pinned.right, 'clicked', () => this._easePinned(adj.page_size * 0.8));
        this._scope.connect(pinned.scroll, 'scroll-event', (a, e) => this._onPinnedWheel(e));
    }

    _updatePinnedIndicators() {
        if (this._closed || !this._pinnedScroll) return;
        const adj = this._pinnedScroll.hadjustment;
        let hiddenLeft = 0, hiddenRight = 0;
        for (const b of this._pinnedButtons) {
            const box = b.get_allocation_box();
            if (box.x1 < adj.value - 1) hiddenLeft++;
            if (box.x2 > adj.value + adj.page_size + 1) hiddenRight++;
        }
        const set = (btn, n, text) => {
            btn.get_child().set_text(text);
            btn.opacity = n > 0 ? 255 : 0;
            btn.reactive = n > 0;
        };
        set(this._pinnedLeft, hiddenLeft, `‹ ${hiddenLeft}`);
        set(this._pinnedRight, hiddenRight, `${hiddenRight} ›`);
    }

    _easePinned(delta) {
        const adj = this._pinnedScroll.hadjustment;
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastPinnedWheel > 250) this._pinnedTarget = adj.value;
        this._lastPinnedWheel = now;
        const max = Math.max(0, adj.upper - adj.page_size);
        this._pinnedTarget = clamp(this._pinnedTarget + delta, 0, max);
        adj.ease(this._pinnedTarget, { duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    _onPinnedWheel(event) {
        const dir = event.get_scroll_direction();
        let d = 0;
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) d = -1;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) d = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        } else return Clutter.EVENT_PROPAGATE;
        this._easePinned(d * this._layout.pinnedTileWidth * 0.8);
        return Clutter.EVENT_STOP;
    }

    _renderPinnedBar() {
        this._pinnedScope.dispose();
        this._pinnedScope = new Scope();
        this._focusedPinnedBtn = null;
        this._pinnedBarBox.destroy_all_children();
        this._pinnedButtons = [];
        this._pinnedItems = [];

        const favorites = this._favorites.getFavorites() ?? [];
        const L = this._layout;

        this._pinnedBarBox.add_child(new St.Widget({ x_expand: true }));      // centring spacers; shrink on overflow
        for (const app of favorites) {
            const id = app.get_id();
            const name = app.get_name?.() || '';
            const icon = app.get_icon();
            const index = this._pinnedItems.length;
            this._pinnedItems.push({ app, name, icon });

            const button = createAppTile({
                icon, name, iconSize: L.pinnedIconSize, width: L.pinnedTileWidth, height: L.pinnedTileHeight,
            });
            button._appName = name;

            this._pinnedScope.connect(button, 'clicked', () => {
                this._zone = 'pinned'; this._pinnedIndex = index; this._refreshFocus();
                if (this._launchApp(app)) this._close();
            });
            this._pinnedScope.connect(button, 'button-press-event', (a, e) => {
                if (e.get_button() === Clutter.BUTTON_SECONDARY) {
                    this._openContextMenuForApp(app, button);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            makeDraggable(button, {
                iconSize: PINNED_ICON_SIZE,
                payload: { kind: 'app', appId: id, gicon: icon, name },
                delegate: this._pinnedStrip.delegate(),
                onDragBegin: () => { this._pinnedDragActive = true; getTooltip().hide(); },
                onDragEnd: () => { this._pinnedDragActive = false; this._ghost.clear(); getTooltip().hide(); },
            });

            this._pinnedBarBox.add_child(button);
            this._pinnedButtons.push(button);

            if (id === this._justDroppedAppId) { this._justDroppedAppId = null; settleIcon(button); }
        }
        this._pinnedBarBox.add_child(new St.Widget({ x_expand: true }));

        this._pinnedIndex = clamp(this._pinnedIndex, 0, Math.max(0, this._pinnedItems.length - 1));
        this._syncSectionVisibility();
        this._scope.idle(() => { this._updatePinnedIndicators(); return GLib.SOURCE_REMOVE; });
    }

    _renderResults(results) {
        const L = this._layout;
        this._focusedGridBtn = null;
        this._gridBox.destroy_all_children();
        this._buttons = [];

        let row = null;
        results.forEach((item, index) => {
            if (index % this._cols === 0) {
                row = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER, width: this._cols * this._tileW });
                this._gridBox.add_child(row);
            }
            const button = createAppTile({
                icon: item.icon, name: item.name, indices: item.indices,
                iconSize: L.iconSize, width: L.tileWidth, height: L.tileHeight,
            });
            // Hover is CSS-only; it never moves keyboard focus.
            this._rowsScope.connect(button, 'clicked', () => {
                this._zone = 'grid'; this._selectedIndex = index; this._refreshFocus();
                this._activateResult(index);
            });
            this._rowsScope.connect(button, 'button-press-event', (a, e) => {
                if (e.get_button() === Clutter.BUTTON_SECONDARY) {
                    this._openContextMenuForApp(item.app, button);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            row.add_child(button);
            this._buttons.push(button);
        });

        if (this._resetScroll) {
            this._gridScroll.vadjustment.value = 0;
            this._scrollTarget = 0;
        }
    }

    _onSelectionChanged() { this._refreshFocus(); }

    // ---- focus ----
    _refreshFocus() {
        this._focusedGridBtn?.remove_style_class_name('focused');
        this._focusedPinnedBtn?.remove_style_class_name('focused');
        this._focusedGridBtn = this._focusedPinnedBtn = null;

        if (this._zone === 'pinned') {
            this._focusedPinnedBtn = this._pinnedButtons[this._pinnedIndex] ?? null;
            this._focusedPinnedBtn?.add_style_class_name('focused');
        } else {
            this._focusedGridBtn = this._buttons[this._selectedIndex] ?? null;
            this._focusedGridBtn?.add_style_class_name('focused');
        }
    }

    _scrollToFocus() {
        if (this._zone === 'grid' && this._focusedGridBtn) {
            Util.ensureActorVisibleInScrollView(this._gridScroll, this._focusedGridBtn);
        } else if (this._zone === 'pinned' && this._focusedPinnedBtn) {
            const adj = this._pinnedScroll.hadjustment;
            const [value, , , , , page] = adj.get_values();
            const box = this._focusedPinnedBtn.get_allocation_box();
            if (box.x1 < value) adj.ease(box.x1 - 16, { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            else if (box.x2 > value + page) adj.ease(box.x2 - page + 16, { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        }
    }

    _afterFocusMove() { this._refreshFocus(); this._scrollToFocus(); }

    _centerX(button) {
        const [x] = button.get_transformed_position();
        return x + button.width / 2;
    }

    _nearestIndex(buttons, cx) {
        let best = 0, bestDist = Infinity;
        buttons.forEach((b, i) => {
            const d = Math.abs(this._centerX(b) - cx);
            if (d < bestDist) { best = i; bestDist = d; }
        });
        return best;
    }

    _moveFocus(dx, dy) {
        if (this._zone === 'pinned') {
            const n = this._pinnedButtons.length;
            if (dx) this._pinnedIndex = clamp(this._pinnedIndex + dx, 0, n - 1);
            else if (dy > 0 && this._buttons.length) {
                const cx = this._centerX(this._pinnedButtons[this._pinnedIndex]);
                this._zone = 'grid';
                this._selectedIndex = this._nearestIndex(this._buttons.slice(0, this._cols), cx);
            }
            this._afterFocusMove();
            return;
        }

        const n = this._buttons.length;
        if (!n) return;
        const cols = this._cols;
        let i = this._selectedIndex;
        if (dx) i = clamp(i + dx, 0, n - 1);
        if (dy) {
            const next = i + dy * cols;
            if (next < 0) {
                if (this._pinnedVisible()) {
                    this._pinnedIndex = this._nearestIndex(this._pinnedButtons, this._centerX(this._buttons[i]));
                    this._zone = 'pinned';
                    this._afterFocusMove();
                }
                return;
            }
            if (next >= n) { if (Math.floor(i / cols) < Math.floor((n - 1) / cols)) i = n - 1; }
            else i = next;
        }
        this._selectedIndex = i;
        this._afterFocusMove();
    }

    _onGridScroll(event) {
        const adj = this._gridScroll.vadjustment;
        const dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP) delta = -1;
        else if (dir === Clutter.ScrollDirection.DOWN) delta = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) delta = event.get_scroll_delta()[1];
        else return Clutter.EVENT_PROPAGATE;

        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastWheel > 250) this._scrollTarget = adj.value;
        this._lastWheel = now;

        const max = adj.upper - adj.page_size;
        this._scrollTarget = clamp(this._scrollTarget + delta * this._layout.tileHeight * 0.75, 0, Math.max(0, max));
        adj.ease(this._scrollTarget, { duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        return Clutter.EVENT_STOP;
    }

    // ---- keys ----
    _handleExtraKeys(event, symbol) {
        const state = event.get_state();
        if (symbol === Clutter.KEY_p && (state & Clutter.ModifierType.CONTROL_MASK)) {
            const item = this._zone === 'pinned' ? this._pinnedItems[this._pinnedIndex] : this._results[this._selectedIndex];
            if (item) this._togglePin(item);
            return Clutter.EVENT_STOP;
        }

        const inEntry = this._entryFocused();
        switch (symbol) {
            case Clutter.KEY_slash:
                if (inEntry) return undefined;                 // types a literal '/'
                this._focusSearch();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Left: this._moveFocus(-1, 0); return Clutter.EVENT_STOP;
            case Clutter.KEY_Right: this._moveFocus(1, 0); return Clutter.EVENT_STOP;
            case Clutter.KEY_Up: this._moveFocus(0, -1); return Clutter.EVENT_STOP;
            case Clutter.KEY_Down: this._moveFocus(0, 1); return Clutter.EVENT_STOP;
        }

        // Type-to-search from navigation mode.
        if (!inEntry && !(state & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK))) {
            const uc = event.get_key_unicode();
            const code = typeof uc === 'string' ? uc.codePointAt(0) : uc;
            if (code && code >= 0x20 && code !== 0x7f) {
                this._focusSearch();
                this._entry.clutter_text.insert_unichar(code);
                return Clutter.EVENT_STOP;
            }
        }
        return undefined;
    }

    // Escape: clear the query and leave search mode first; close when the field is already empty.
    _handleEscape() {
        if (this._entry.get_text().length > 0) {
            this._entry.set_text('');
            this._container.grab_key_focus();
            return;
        }
        this._close();
    }

    _activateFocused() {
        if (this._zone === 'pinned') {
            const item = this._pinnedItems[this._pinnedIndex];
            if (item && this._launchApp(item.app)) this._close();
            return;
        }
        if (this._selectedIndex >= 0) this._activateResult(this._selectedIndex);
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (item && this._launchApp(item.app)) this._close();   // stay open if the launch failed
    }

    // ---- pinning / context menu ----
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

        // Clicking a window entry in this menu focuses that window, and the
        // base class closes the overlay on any focus change.
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

    _togglePin(item) {
        if (this._closed) return;
        const id = item.app.get_id();
        if (this._favorites.isFavorite(id)) this._favorites.removeFavorite(id);
        else this._favorites.addFavorite(id);
    }

    _onFavoritesChanged() {
        if (this._closed) return;
        this._allItemsCache = null;
        this._renderPinnedBar();
        this._onSearchChanged();
        this._refreshFocus();
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
}