import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as AppMenuModule from 'resource:///org/gnome/shell/ui/appMenu.js';

import * as Scheduling from './scheduling.js';
import * as Fuzzy from './fuzzy.js';
import * as Model from './model.js';
import * as Interactions from './interactions.js';
import * as UI from './ui.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ==================== DISCRETE FOCUS STRIP ====================
function neighborOpacity(x) {
    if (x <= 1) return 0.95;
    if (x <= 2) return 0.95 - 0.20 * (x - 1);        // x=2: 0.75
    return Math.max(0, 0.75 * (1 - (x - 2) / 0.8));  // gone by x=2.8
}

// ==================== RAIL TICK COLORS ====================
const SOLARIZED = [
    '#268bd2', '#cb4b16', '#859900', '#d33682',
    '#2aa198', '#b58900', '#6c71c4', '#dc322f',
];

function appColor(appName) {
    let h = 0;
    for (let i = 0; i < appName.length; i++) h = (h * 31 + appName.charCodeAt(i)) | 0;
    return SOLARIZED[Math.abs(h) % SOLARIZED.length];
}

// ==================== per-overlay layout ====================
function computeSelectorLayout(monitor) {
    const W = monitor.width, H = monitor.height;

    // Center is the reference. Everything else derives from it by ratio.
    //   center  = 1.00  (band title, weight 700)
    //   x=1 row = 0.88  (rowLabelSize, weight 500)
    //   x=2 row = 0.62  (via set_scale on top of rowLabelSize)
    const selLabel = Math.max(40, Math.min(92, Math.round(H * 0.072)));
    const selectedHeight = Math.round(selLabel * 1.95);

    const rowLabelSize = Math.round(selLabel * 0.88);
    const rowIconSize = Math.round(rowLabelSize * 1.15);
    const slotH = Math.round(rowLabelSize * 1.55);

    const searchHeight = 104;
    const bandHeight = selectedHeight + searchHeight + 40;

    const railWidth = 48;
    const railMargin = 14;
    const railPad = 10;
    const railH = Math.round(H * 0.80);
    const railY = Math.round((H - railH) / 2);

    return {
        monitorWidth: W, monitorHeight: H,
        slotH, selectedHeight, bandHeight,
        bandTop: Math.round((H - bandHeight) / 2),
        searchWidth: Math.min(W - 96, Math.round(W * 0.78)),
        iconSize: rowIconSize,
        selectedIconSize: Math.round(selLabel * 1.55),
        rowLabelSize,
        selectedLabelSize: selLabel,
        rowTextMax: Math.round(W * 0.78),
        railWidth, railMargin, railH, railY, railPad,
        railX: W - railMargin - railWidth,
    };
}

function computeLauncherLayout(monitor) {
    const margin = Math.max(24, Math.round(monitor.height * 0.04));
    const searchHeight = 160;
    const searchWidth = Math.min(1100, monitor.width - margin * 2);

    const searchY = margin;
    const pinnedY = searchY + searchHeight + 16;
    const pinnedHeight = 240;

    const resultsY = pinnedY + pinnedHeight + 16;
    const resultsHeadingHeight = 70;
    const resultsHeight = Math.max(240, monitor.height - resultsY - margin);

    const fullWidth = monitor.width - margin * 2;
    const innerWidth = fullWidth - 40;
    const columns = Math.max(2, Math.min(8, Math.floor(innerWidth / 240)));
    const tileWidth = Math.floor(innerWidth / columns);

    return {
        margin, searchWidth,
        searchX: Math.round((monitor.width - searchWidth) / 2), searchY,
        fullWidth, fullX: margin,
        pinnedY, pinnedHeight,
        resultsY, resultsHeadingHeight, resultsHeight,
        columns, tileWidth, tileHeight: 340, iconSize: 144,
        pinnedTileWidth: 200, pinnedTileHeight: 200, pinnedIconSize: 160,
    };
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
        this._initialKey = null;
        this._modalGrab = null;
        this._closed = false;
        this._closing = false;
        this._focusGuard = false;

        this._scope = new Scheduling.Scope();
        this._rowsScope = new Scheduling.Scope();
    }

    _trackFullscreen() { return true; }
    _computeResults(query) { return []; }
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

        this._scope.connect(this._container, 'key-press-event', (a, e) => this._onKeyPress(e));

        this._scope.connect(Model.Display, 'notify::focus-window', () => {
            if (this._closed || this._closing || this._focusGuard) return;
            this._close();
        });
        this._scope.connect(Model.Display, 'window-created', () => {
            if (!this._closed && !this._closing) this._close();
        });
        // MetaDisplay has no 'window-removed'. Destruction is signalled by
        // the compositor's window manager on the per-actor 'destroy' signal;
        // actor.meta_window is still valid there.
        this._scope.connect(global.window_manager, 'destroy', (wm, actor) => {
            const window = actor.meta_window;
            if (!window || this._closed || this._closing || !this._shouldCloseOnWindowRemoved(window)) return;
            this._close();
        });
    }

    _close() {
        if (this._closed) return;
        this._closed = true;
        Interactions.getTooltip().hide();
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

    _setResults(results, keepSelection = true) {
        const prev = this._results[this._selectedIndex];
        let previousKey = keepSelection && prev ? this._getRestoreKey(prev) : null;

        if (previousKey === null && this._initialKey !== null) previousKey = this._initialKey;
        this._initialKey = null;

        this._results = results;
        this._rowsScope.dispose();
        this._rowsScope = new Scheduling.Scope();
        this._selectedIndex = -1;
        this._renderResults(results);

        if (results.length === 0) { this._onSelectionChanged(-1); return; }
        const restored = previousKey !== null
            ? results.findIndex(item => this._getRestoreKey(item) === previousKey) : -1;
        this._selectIndex(restored >= 0 ? restored : 0);
    }

    _selectIndex(index) {
        if (this._closed || index < 0 || index >= this._results.length) return;
        if (index === this._selectedIndex) return;
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

// ==================== window selector (v4: discrete focus strip + scrubber) ====================
export class WindowSearchOverlay extends SearchOverlayBase {
    constructor(windows, settings, focusedWindow = null) {
        super(settings);
        this._focusedWindow = focusedWindow ?? Model.Display.focus_window;

        this._items = windows.map(w => ({
            window: w,
            title: w.get_title() || 'Untitled Window',
            appName: this._getAppName(w),
            icon: UI.getWindowAppIcon(w),
        }));

        this._rows = [];
        this._scrollAccum = 0;
        this._scrollPos = 0;
        this._scrollTarget = 0;
        this._tweenId = 0;
        this._lastFrame = 0;
        this._lastScrollStep = 0;
        this._snap = true;

        this._origin = {
            window: Model.Display.focus_window,
            workspace: Model.WorkspaceManager.get_active_workspace(),
        };
        this._revealed = null;
        this._revealedAny = false;
        this._maximizedWindow = null;
        this._revealTimer = 0;
        this._guardTimer = 0;
        this._cancelled = false;

        this._hintLabel = null;

        // Rail state
        this._rail = null;
        this._railTicksBox = null;
        this._railTicks = [];
        this._railMarker = null;
        this._railTip = null;
        this._railGrab = null;
        this._railDragging = false;
        this._railH = 0;
        this._railPad = 0;

        this._buildUI();
        this._initialKey = this._focusedWindow ?? null;
        this._onSearchChanged();
        this._open();
    }

    _trackFullscreen() { return false; }
    _getRestoreKey(item) { return item.window; }

    // Only close if a window actually shown in the current (possibly
    // filtered) list disappears. `_results` is populated before `_open()`
    // wires the destroy handler, so this is always safe to consult.
    _shouldCloseOnWindowRemoved(window) {
        return this._results.some(item => item.window === window);
    }

    _matchItem(query, item) {
        const r = Fuzzy.fuzzyMatch(query, `${item.title} ${item.appName}`);
        if (!r.matched) return r;
        return { ...r, indices: new Set([...r.indices].filter(i => i < item.title.length)) };
    }

    _computeResults(query) {
        if (!query) return this._items.map(item => ({ ...item, indices: null }));

        const scored = [];
        for (const item of this._items) {
            const r = this._matchItem(query, item);
            if (r.matched) scored.push({ ...item, score: r.score, indices: r.indices });
        }
        return scored.sort((a, b) => b.score - a.score);
    }

    _getAppName(window) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        return app ? app.get_name() : (window.get_wm_class() || 'Unknown');
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        const L = this._layout = computeSelectorLayout(monitor);
        this._monitor = monitor;
        this._container = UI.createFullscreenContainer(monitor, 'window-selector-overlay');
        this._container.add_style_class_name('search-mode');

        const size = { width: L.monitorWidth, height: L.monitorHeight };
        this._tint = new St.Widget({ style_class: 'selector-tint', reactive: false, opacity: 255, ...size });
        this._listLayer = new St.Widget(size);

        const { band, titleBin } = UI.createSelectionBand(L);
        this._bandBin = titleBin;
        this._band = band;

        const search = UI.createSearchField({ width: L.searchWidth, hint: 'Type to search…' });
        this._wireEntry(search.entry);
        this._searchRoot = search.actor;
        band.add_child(new St.Bin({ x_expand: true, x_align: Clutter.ActorAlign.CENTER, child: search.actor }));

        const hint = UI.createSelectorHint(L);
        this._hintLabel = hint.label;

        for (const actor of [
            this._tint, this._listLayer,
            band, hint.actor,
        ]) this._container.add_child(actor);

        this._buildRail();

        this._scope.connect(this._container, 'scroll-event', (a, e) => this._onScroll(e));
        this._scope.connect(this._container, 'button-release-event', (a, e) => this._onClick(e));

        this._scope.connect(global.stage, 'notify::key-focus', () => {
            if (this._closed || this._closing) return;
            if (global.stage.get_key_focus() === this._entry.clutter_text) return;
            this._refocusEntry();
        });
    }

    // ----- rail widget tree -----
    _buildRail() {
        const L = this._layout;
        this._railH = L.railH;
        this._railPad = L.railPad;

        this._rail = new St.Widget({
            style_class: 'selector-rail',
            reactive: true, track_hover: true,
            x: L.railX, y: L.railY,
            width: L.railWidth, height: L.railH,
        });

        const track = new St.Widget({
            style_class: 'selector-rail-track',
            x: Math.round((L.railWidth - 2) / 2),
            y: 0, width: 2, height: L.railH,
        });
        this._rail.add_child(track);

        this._railTicksBox = new St.Widget({ x: 0, y: 0, width: L.railWidth, height: L.railH });
        this._rail.add_child(this._railTicksBox);

        this._railMarker = new St.Widget({
            style_class: 'selector-rail-marker',
            x: Math.round((L.railWidth - 32) / 2),
            y: 0, width: 32, height: 8,
        });
        this._rail.add_child(this._railMarker);

        const tipFontSize = Math.round(L.selectedLabelSize * 0.45);
        const tipWidth = Math.min(700, Math.round(L.monitorWidth * 0.45));

        this._railTip = new St.Label({
            style_class: 'selector-rail-tip', text: '',
            x: 0, y: 0, width: tipWidth, opacity: 0,
        });
        this._railTip.set_style(`font-size: ${tipFontSize}px; font-weight: 600;`);
        this._railTip.clutter_text.set_ellipsize(Pango.EllipsizeMode.START);
        this._railTip.clutter_text.set_line_wrap(false);

        this._container.add_child(this._rail);
        this._container.add_child(this._railTip);

        this._wireRail();
    }

    _wireRail() {
        const rail = this._rail;
        const scope = this._scope;

        scope.connect(rail, 'button-press-event', (a, e) => {
            if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            this._railDragging = true;
            this._acquireRailGrab();
            this._railPointerFromEvent(e);
            return Clutter.EVENT_STOP;
        });

        scope.connect(rail, 'motion-event', (a, e) => {
            if (this._railDragging) {
                this._railPointerFromEvent(e);
                return Clutter.EVENT_STOP;
            }
            const [, y] = e.get_coords();
            const [, ry] = rail.get_transformed_position();
            const idx = this._railIndexFromY(y - ry);
            const item = this._results[idx];
            if (item) this._showRailTip(idx, item);
            return Clutter.EVENT_PROPAGATE;
        });

        scope.connect(rail, 'button-release-event', (a, e) => {
            if (!this._railDragging) return Clutter.EVENT_PROPAGATE;
            this._railDragging = false;
            this._releaseRailGrab();
            this._hideRailTip();
            return Clutter.EVENT_STOP;
        });

        scope.connect(rail, 'leave-event', () => {
            if (!this._railDragging) this._hideRailTip();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Preferred on Shell 45+: Clutter.grab returns a lightweight pointer
    // grab that coexists with the container's pushModal. On Shell 42–44
    // Clutter.grab doesn't exist (or returns null), so fall back to a
    // second pushModal stacked on top. Either way, storing the handle in
    // _railGrab lets _releaseRailGrab() unwind it uniformly.
    _acquireRailGrab() {
        try {
            const grab = Clutter.grab?.(this._rail);
            if (grab) { this._railGrab = { dismiss: () => grab.dismiss() }; return; }
        } catch (e) {
            journal(`[rail] Clutter.grab failed: ${e.message}`);
        }
        try {
            const modal = Main.pushModal(this._rail, { actionMode: Shell.ActionMode.NORMAL });
            this._railGrab = { modal };
        } catch (e) {
            journal(`[rail] pushModal fallback failed: ${e.message}`);
            this._railGrab = null;
            this._railDragging = false;
        }
    }

    _releaseRailGrab() {
        const g = this._railGrab;
        this._railGrab = null;
        if (!g) return;
        if (g.modal) { try { Main.popModal(g.modal); } catch (e) { /* already popped */ } }
        else { try { g.dismiss(); } catch (e) { /* already dismissed */ } }
    }

    _railY(i) {
        const n = this._results.length;
        const span = Math.max(1, this._railH - this._railPad * 2);
        if (n <= 1) return this._railH / 2;
        return this._railPad + (i / (n - 1)) * span;
    }

    _railIndexFromY(py) {
        const n = this._results.length;
        if (n <= 1) return 0;
        const span = Math.max(1, this._railH - this._railPad * 2);
        return clamp(Math.round(((py - this._railPad) / span) * (n - 1)), 0, n - 1);
    }

    _buildRailTicks() {
        if (!this._railTicksBox || !this._rail) return;
        this._railTicksBox.destroy_all_children();
        this._railTicks = [];

        const n = this._results.length;
        this._rail.visible = n > 0;
        if (n === 0) return;

        const W = this._layout.railWidth;
        for (let i = 0; i < n; i++) {
            const item = this._results[i];
            const tick = new St.Widget({
                style_class: 'selector-rail-tick',
                x: Math.round((W - 12) / 2),
                y: Math.round(this._railY(i) - 2),
                width: 12, height: 4,
            });
            tick.set_style(`background-color: ${appColor(item.appName || '')};`);
            this._railTicksBox.add_child(tick);
            this._railTicks.push(tick);
        }
        this._updateRailMarker();
    }

    _updateRailMarker() {
        if (!this._railMarker || !this._results.length) return;
        const p = clamp(this._scrollPos, 0, this._results.length - 1);
        const lo = Math.floor(p);
        const hi = Math.min(this._results.length - 1, lo + 1);
        const y = this._railY(lo) + (this._railY(hi) - this._railY(lo)) * (p - lo);
        this._railMarker.set_position(this._railMarker.x, Math.round(y - this._railMarker.height / 2));
    }

    _railPointerFromEvent(event) {
        const [, y] = event.get_coords();
        const [, ry] = this._rail.get_transformed_position();
        const idx = this._railIndexFromY(y - ry);
        const item = this._results[idx];
        if (!item) return;
        this._selectIndex(idx);
        this._showRailTip(idx, item);
    }

    _showRailTip(idx, item) {
        if (!this._railTip) return;
        const text = `${item.appName} — ${item.title}`;
        this._railTip.set_text(text);

        // .height is the allocation from the previous layout pass — correct on
        // every hover after the first. On the very first hover it's still 0
        // (set_text queues a relayout, doesn't flush), so fall back to a sane
        // estimate so the tip lands somewhere visible instead of off-screen.
        const h = this._railTip.height > 0 ? this._railTip.height : 58;
        const tipX = Math.max(8, this._layout.railX - this._railTip.width - 8);
        const tipY = clamp(
            this._layout.railY + this._railY(idx) - Math.round(h / 2),
            8,
            this._layout.monitorHeight - h - 8);
        this._railTip.set_position(tipX, tipY);
        this._railTip.opacity = 255;
    }

    _hideRailTip() {
        if (this._railTip) this._railTip.opacity = 0;
    }

    // ----- rows -----
    _renderResults(results) {
        const L = this._layout;

        // Cancel any in-progress rail drag (results are being replaced)
        this._releaseRailGrab();
        this._railDragging = false;
        this._hideRailTip();

        this._listLayer.destroy_all_children();
        this._rows = results.map((item, index) => {
            const row = UI.createWindowTitleRow({
                icon: item.icon, title: item.title, indices: item.indices,
                width: L.monitorWidth, height: L.slotH,
                iconSize: L.iconSize,
                labelSize: L.rowLabelSize,
                maxWidth: L.rowTextMax,
            });
            this._rowsScope.connect(row, 'button-press-event', (a, e) => {
                if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
                this._selectIndex(index);
                return Clutter.EVENT_STOP;
            });
            this._rowsScope.connect(row, 'button-release-event', (a, e) => {
                if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
                return Clutter.EVENT_STOP;
            });
            this._listLayer.add_child(row);
            return row;
        });
        this._snap = true;
        this._buildRailTicks();
    }

    // ----- discrete focus strip layout -----
    _layoutRows() {
        const L = this._layout;
        const pos = this._scrollPos;
        const a = L.bandTop - L.slotH / 2;
        const b = L.bandTop + L.bandHeight + L.slotH / 2;
        const mid = (a + b) / 2;
        const half = (b - a) / 2;

        // Row (x=1) is at rowLabelSize = 0.88 * center.
        // Second neighbor (x=2) needs to land at 0.62 * center, so scale = 0.62/0.88 = 0.705.
        const SECOND_NEIGHBOR_SCALE = 0.62 / 0.88;
        const scaleAt = (x) => {
            if (x <= 1.5) return 1;
            if (x >= 2.0) return SECOND_NEIGHBOR_SCALE;
            const t = (x - 1.5) / 0.5;
            return 1 - (1 - SECOND_NEIGHBOR_SCALE) * ease(t);
        };

        this._rows.forEach((row, i) => {
            const d = i - pos;
            const x = Math.abs(d);

            if (x >= 2.8) { row.hide(); return; }

            let c, op;
            if (x < 1) {
                c = mid + d * half;
                op = neighborOpacity(1) * ease((x - 0.2) / 0.8);
            } else {
                c = d > 0 ? b + (x - 1) * L.slotH : a - (x - 1) * L.slotH;
                op = neighborOpacity(x);
            }
            if (op < 0.01) { row.hide(); return; }

            row.show();
            row.set_position(0, Math.round(c - L.slotH / 2));
            row.set_opacity(Math.round(op * 255));
            row.set_pivot_point(0.5, 0.5);
            const s = scaleAt(x);
            row.set_scale(s, s);
            row.set_reactive(x >= 1);
        });

        this._bandBin.opacity = Math.round(255 * ease(1 - Math.abs(this._selectedIndex - pos)));
        this._updateRailMarker();
    }

    // ----- selection -----
    _onSelectionChanged(index) {
        if (index < 0) {
            this._bandBin.set_child(null);
            this._cancelReveal();
            this._updateHint();
            return;
        }
        const item = this._results[index];
        const L = this._layout;
        this._bandBin.set_child(UI.createBandTitle({
            icon: item.icon,
            title: item.title,
            appName: (item.appName || '').toUpperCase(),
            width: L.monitorWidth,
            height: L.selectedHeight,
            iconSize: L.selectedIconSize,
            labelSize: L.selectedLabelSize,
            appSize: Math.max(12, Math.round(L.selectedLabelSize * 0.30)),
        }));

        this._scrollTarget = index;
        if (this._snap) { this._scrollPos = index; this._layoutRows(); this._snap = false; }
        else this._startTween();

        this._scheduleReveal(item);
        this._updateHint();
    }

    _updateHint() {
        if (!this._hintLabel) return;
        const total = this._results.length;
        if (total === 0) {
            this._hintLabel.set_text('No matching windows   •   Esc to Close');
            return;
        }
        this._hintLabel.set_text(
            `${this._selectedIndex + 1} / ${total}   •   ↑↓ Navigate   •   Drag the right rail to jump   •   Enter / Click to Activate   •   Esc to Close`);
    }

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
            this._scrollPos += diff * (1 - Math.exp(-dt / 70));
            this._layoutRows();
            return GLib.SOURCE_CONTINUE;
        });
    }

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

    _revealWindow(win) {
        if (this._closed || this._closing || win === this._revealed) return;
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
        this._refocusEntry();
    }

    _refocusEntry() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._closed || this._closing) return GLib.SOURCE_REMOVE;
            this._entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _releaseRevealed() {
        const win = this._maximizedWindow;
        this._maximizedWindow = null;
        if (!win) return;
        try { win.unmaximize(Meta.MaximizeFlags.BOTH); } catch (e) { /* window gone */ }
    }

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
        if (this._closed || this._closing) return;
        this._cancelled = true;
        this._container.add_style_class_name('selector-cancelling');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
            if (!this._closed) this._close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onBeforeClose() {
        this._releaseRailGrab();
        this._railDragging = false;
        this._cancelReveal();
        this._releaseRevealed();
        if (this._cancelled) this._restoreOrigin();
    }

    _handleExtraKeys(event, symbol) {
        if (symbol === Clutter.KEY_Page_Down) { this._selectIndex(Math.min(this._selectedIndex + 5, this._results.length - 1)); return Clutter.EVENT_STOP; }
        if (symbol === Clutter.KEY_Page_Up) { this._selectIndex(Math.max(this._selectedIndex - 5, 0)); return Clutter.EVENT_STOP; }
        return undefined;
    }

    _onClick(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
        if (this._closing) return Clutter.EVENT_STOP;
        const src = event.get_source();
        if (src && this._searchRoot.contains(src)) {
            this._entry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        }
        this._activateFocused();
        return Clutter.EVENT_STOP;
    }

    _activateResult(index) {
        if (this._closed || this._closing) return;
        const item = this._results[index];
        if (!item) return;
        const window = item.window;

        this._closing = true;
        this._cancelReveal();
        this._releaseRevealed();

        try {
            if (window.minimized) window.unminimize();
            const ws = window.get_workspace();
            if (ws) ws.activate_with_focus(window, global.get_current_time());
            else window.activate(global.get_current_time());
        } catch (e) {
            journal(`[WindowSearchOverlay] activate failed: ${e.message}`, true);
        }

        this._container.ease({
            opacity: 0, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (!this._closed) this._close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _close() {
        if (this._closed) return;
        journal('[WindowSearchOverlay] Closing');
        super._close();
    }
}

// ==================== app launcher ====================
const PINNED_ICON_SIZE = 160;

export class AppSearchOverlay extends SearchOverlayBase {
    constructor(settings) {
        super(settings);
        this._favorites = AppFavorites.getAppFavorites();
        this._menuManager = null;
        this._openMenu = null;

        this._justDroppedAppId = null;
        this._apps = null;
        this._pinnedScope = new Scheduling.Scope();
        this._ghost = Interactions.createReorderGhost({ iconSize: () => PINNED_ICON_SIZE });

        this._zone = 'grid';
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
        this._pinnedAdj = null;
        this._pinnedLeftFade = null;
        this._pinnedRightFade = null;

        this._buildUI();
        this._onSearchChanged();
        this._refreshFocus();
        this._open();
    }

    _initialKeyFocus() { this._container.grab_key_focus(); }
    _entryFocused() { return global.stage.get_key_focus() === this._entry.clutter_text; }
    _focusSearch() { this._entry.grab_key_focus(); }

    _getRestoreKey(item) { return item.app.get_id(); }
    _pinnedVisible() { return this._pinnedSection.visible && this._pinnedButtons.length > 0; }

    _shouldCloseOnWindowRemoved() { return false; }

    _getAllApps() {
        if (this._apps) return this._apps;

        const appSystem = Shell.AppSystem.get_default();
        const apps = [];
        for (const info of Gio.AppInfo.get_all()) {
            if (!info.should_show()) continue;
            const app = appSystem.lookup_app(info.get_id());
            if (app) apps.push({ app, name: app.get_name() || '', icon: app.get_icon() });
        }
        apps.sort((a, b) => a.name.localeCompare(b.name));
        return (this._apps = apps);
    }

    _launchApp(app) {
        const name = app.get_name();
        try {
            app.launch(global.get_current_time(), -1, 0);
            journal(`[AppSearchOverlay] ✅ Launched successfully: ${name}`);
            return true;
        } catch (e) {
            journal(`[AppSearchOverlay] ❌ Launch failed for ${name}: ${e.message}`, true);
            return false;
        }
    }

    _computeResults(query) {
        const all = this._getAllApps();
        if (!query) return all.map(item => ({ ...item, indices: null }));

        const scored = [];
        for (const item of all) {
            const r = Fuzzy.fuzzyMatch(query, item.name);
            if (r.matched) scored.push({ ...item, score: r.score, indices: r.indices });
        }
        scored.sort((a, b) => b.score - a.score);

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
            groups = Shell.AppSystem.search(query);
        } catch (e) {
            journal(`[AppSearchOverlay] Shell.AppSystem.search() threw: ${e.message}`);
            return [];
        }
        if (!groups || groups.length === 0) return [];

        const itemByApp = new Map();
        for (const item of allItems) itemByApp.set(item.app, item);

        const results = [];
        for (const group of groups) {
            if (!group || group.length === 0) continue;
            const resolved = [];
            for (const id of group) {
                const app = appSystem.lookup_app(id);
                if (!app) continue;
                const item = itemByApp.get(app);
                if (item) resolved.push({ id, item });
            }
            if (resolved.length === 0) continue;
            resolved.sort((a, b) => usage.compare(a.id, b.id));
            for (const { item } of resolved) results.push(item);
        }
        return results;
    }

    _beforeResults(query, unchanged) {
        const searching = query.length > 0;
        if (searching && this._zone === 'pinned') this._zone = 'grid';
        this._searching = searching;
        this._resetScroll = !unchanged;
        this._syncSectionVisibility();
    }

    _syncSectionVisibility() {
        this._pinnedSection.visible = this._pinnedItems.length > 0;
        this._allHeadingLabel.set_text(this._searching ? 'RESULTS' : 'ALL APPS');
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        const L = this._layout = computeLauncherLayout(monitor);
        this._cols = L.columns;
        this._tileW = L.tileWidth;
        this._container = UI.createFullscreenContainer(monitor, 'launcher-overlay');

        const search = UI.createSearchField({
            width: L.searchWidth, hint: 'Search', keyHint: "Press '/' to search", x: L.searchX, y: L.searchY,
        });
        this._wireEntry(search.entry);
        this._container.add_child(search.actor);

        const pinned = UI.createPinnedRow();
        this._pinnedBarBox = pinned.box;
        this._pinnedLeftFade = pinned.leftFade;
        this._pinnedRightFade = pinned.rightFade;
        this._wirePinnedScroll(pinned);
        this._pinnedStrip = Interactions.createDropStrip({
            container: this._pinnedBarBox, ghost: this._ghost,
            acceptSource: source => source?._dragPayload?.kind === 'app',
            externalResult: Interactions.DragMotionResult.NO_DROP,
            hint: {
                show: (anchor, text) => Interactions.getTooltip().showAbove(anchor, text, this._settings.get_int('tooltip-font-size')),
                hide: () => Interactions.getTooltip().hide(),
            },
            hintText: insertion => {
                if (!insertion.neighbor) return 'Pin here';
                const name = insertion.neighbor._appName ?? '';
                return insertion.insertBefore ? `Move before ${name}` : `Move after ${name}`;
            },
            onDrop: (source, index, actor) => this._dropPinned(source, index, actor),
        });
        this._pinnedBarBox._delegate = this._pinnedStrip.delegate();

        this._pinnedSection = new St.BoxLayout({
            style_class: 'launcher-pinned-section', vertical: true,
            x: L.fullX, y: L.pinnedY, width: L.fullWidth, height: L.pinnedHeight,
        });
        const pinnedHeading = UI.createDividerHeading('PINNED APPS');
        this._pinnedSection.add_child(pinnedHeading.actor);
        this._pinnedSection.add_child(pinned.actor);
        this._container.add_child(this._pinnedSection);

        const heading = UI.createDividerHeading('ALL APPS');
        this._allHeadingLabel = heading.label;
        heading.actor.set_position(L.fullX, L.resultsY);
        heading.actor.set_size(L.fullWidth, L.resultsHeadingHeight);
        this._container.add_child(heading.actor);

        const grid = UI.createGridScroll();
        this._gridScroll = grid.scroll;
        this._gridBox = grid.box;
        grid.scroll.set_position(L.fullX, L.resultsY + L.resultsHeadingHeight);
        grid.scroll.set_size(L.fullWidth, L.resultsHeight - L.resultsHeadingHeight);
        this._container.add_child(grid.scroll);

        this._scope.connect(this._gridScroll, 'scroll-event', (a, e) => this._onGridScroll(e));
        this._scope.connect(this._favorites, 'changed', () => this._onFavoritesChanged());
        this._scope.connect(Shell.AppSystem.get_default(), 'installed-changed', () => { this._apps = null; });

        this._renderPinnedBar();
    }

    _wirePinnedScroll(pinned) {
        this._pinnedAdj = pinned.scroll.hadjustment;
        const update = () => this._updatePinnedFades();
        this._scope.connect(this._pinnedAdj, 'changed', update);
        this._scope.connect(this._pinnedAdj, 'notify::value', update);
        this._scope.connect(pinned.scroll, 'scroll-event', (a, e) => this._onPinnedWheel(e));
    }

    _updatePinnedFades() {
        const adj = this._pinnedAdj;
        if (!adj) return;
        const eps = 1;
        this._pinnedLeftFade.visible = adj.value > eps;
        this._pinnedRightFade.visible = adj.value + adj.page_size < adj.upper - eps;
    }

    _easePinned(delta) {
        const adj = this._pinnedAdj;
        if (!adj) return;
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
        this._pinnedScope = new Scheduling.Scope();
        this._focusedPinnedBtn = null;
        this._pinnedBarBox.destroy_all_children();
        this._pinnedButtons = [];
        this._pinnedItems = [];

        const L = this._layout;

        this._pinnedBarBox.add_child(new St.Widget({ x_expand: true }));
        for (const app of this._favorites.getFavorites()) {
            const id = app.get_id();
            const name = app.get_name() || '';
            const icon = app.get_icon();
            const index = this._pinnedItems.length;
            this._pinnedItems.push({ app, name, icon });

            const button = UI.createAppTile({
                icon, name, iconSize: L.pinnedIconSize,
                width: L.pinnedTileWidth, height: L.pinnedTileHeight,
                showLabel: false,
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
            this._pinnedScope.connect(button, 'notify::hover', () => {
                if (this._closed) return;
                if (button.hover) {
                    Interactions.getTooltip().showBelow(button, name, this._settings.get_int('tooltip-font-size'));
                } else {
                    Interactions.getTooltip().hide();
                }
            });

            Interactions.makeDraggable(button, {
                iconSize: PINNED_ICON_SIZE,
                payload: { kind: 'app', appId: id, gicon: icon, name },
                delegate: this._pinnedStrip.delegate(),
                onDragBegin: () => { Interactions.getTooltip().hide(); },
                onDragEnd: () => { this._ghost.clear(); Interactions.getTooltip().hide(); },
            });

            this._pinnedBarBox.add_child(button);
            this._pinnedButtons.push(button);

            if (id === this._justDroppedAppId) { this._justDroppedAppId = null; Interactions.settleIcon(button); }
        }
        this._pinnedBarBox.add_child(new St.Widget({ x_expand: true }));

        this._pinnedIndex = clamp(this._pinnedIndex, 0, Math.max(0, this._pinnedItems.length - 1));
        this._syncSectionVisibility();
        this._scope.idle(() => { this._updatePinnedFades(); return GLib.SOURCE_REMOVE; });
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
            const button = UI.createAppTile({
                icon: item.icon, name: item.name, indices: item.indices,
                iconSize: L.iconSize, width: L.tileWidth, height: L.tileHeight,
            });
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
        } else if (this._zone === 'pinned' && this._focusedPinnedBtn && this._pinnedAdj) {
            const adj = this._pinnedAdj;
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
                if (inEntry) return undefined;
                this._focusSearch();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Left: this._moveFocus(-1, 0); return Clutter.EVENT_STOP;
            case Clutter.KEY_Right: this._moveFocus(1, 0); return Clutter.EVENT_STOP;
            case Clutter.KEY_Up: this._moveFocus(0, -1); return Clutter.EVENT_STOP;
            case Clutter.KEY_Down: this._moveFocus(0, 1); return Clutter.EVENT_STOP;
        }

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
        if (item && this._launchApp(item.app)) this._close();
    }

    _dropPinned(source, index, actor) {
        const appId = source?._dragPayload?.appId;
        if (!appId) return false;

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

        const menu = new AppMenuModule.AppMenu(sourceActor, St.Side.BOTTOM, { favoritesSection: true, showSingleWindows: true });
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

    _togglePin(item) {
        if (this._closed) return;
        const id = item.app.get_id();
        if (this._favorites.isFavorite(id)) this._favorites.removeFavorite(id);
        else this._favorites.addFavorite(id);
    }

    _onFavoritesChanged() {
        if (this._closed) return;
        this._renderPinnedBar();
        this._onSearchChanged();
        this._refreshFocus();
    }

    _onBeforeClose() {
        this._closeContextMenu();
        this._ghost.clear();
        this._pinnedScope.dispose();
        Interactions.getTooltip().hide();
        this._apps = null;
    }

    _close() {
        if (this._closed) return;
        super._close();
    }
}