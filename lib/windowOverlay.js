import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Fuzzy from './fuzzy.js';
import * as Model from './model.js';
import * as UI from './ui.js';
import * as WorkspaceActions from './workspaceActions.js';
import * as Motion from './motion.js';
import * as Interactions from './interactions.js';
import * as SelectedWindows from './selectedWindows.js';
import { Smoother } from './smoother.js';
import { S } from './sizes.js';

import { SearchOverlayBase, clamp, ease } from './overlayBase.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

function neighborOpacity(x) {
    if (x <= 1) return 1.00;
    if (x <= 2) return 1.00 - 0.15 * (x - 1);
    return Math.max(0, 0.85 * (1 - (x - 2) / 0.8));
}

const appColor = name => UI.colorForApp(name);

const MAX_ROWS_EACH_SIDE = 2;
const rowsEachSideFor = n => Math.min(MAX_ROWS_EACH_SIDE, Math.max(0, n - 1));

function usableArea(monitor) {
    const pb = Main.layoutManager.panelBox;
    let { x, y, width, height } = monitor;
    if (pb && pb.height > 0) {
        const atBottom = pb.y + pb.height / 2 > monitor.y + monitor.height / 2;
        height -= pb.height;
        if (!atBottom) y += pb.height;
    }
    return { x, y, width, height };
}

function computeOverlayLayout(monitor) { return usableArea(monitor); }

function computeRailLayout(overlay) {
    const width = 48, margin = 14, pad = 10;
    const height = Math.round(overlay.height * 0.80);
    return {
        x: overlay.width - margin - width,
        y: Math.round((overlay.height - height) / 2),
        width, height, margin, pad,
        gutter: margin + width + margin,
    };
}

function computeBandLayout(overlay, rail) {
    const selectedHeight = S.selector.bandH;
    const searchHeight = S.selector.searchH;
    const filterHeight = S.selector.filterH;
    const height = selectedHeight + searchHeight + filterHeight + 90;
    const width = Math.max(400, overlay.width - rail.gutter * 2);
    return {
        x: Math.round((overlay.width - width) / 2),
        y: Math.round((overlay.height - height) / 2),
        width, height,
        selectedHeight, searchHeight, filterHeight,
        searchWidth: Math.min(1200, Math.round(width * 0.55)),
    };
}

function computeRowLayout(overlay, band) {
    return {
        rowLabelSize: S.selector.rowLabel,
        rowIconSize: S.selector.rowIcon,
        slotH: S.selector.rowSlot,
        rowTextMax: Math.round(band.width * 0.85),
        tipWidth: Math.min(700, Math.round(overlay.width * 0.45)),
    };
}

export class WindowSearchOverlay extends SearchOverlayBase {
    constructor(windows, settings, focusedWindow = null, initialFilters = null) {
        super(settings);
        this._focusedWindow = focusedWindow ?? Model.Display.focus_window;

        this._items = windows.map(w => {
            const app = UI.getWindowApp(w);
            return {
                window: w,
                title: w.get_title() || 'Untitled Window',
                appName: app?.get_name() || w.get_wm_class() || 'Unknown',
                appId: app?.get_id() || null,
                icon: UI.getWindowAppIcon(w),
            };
        });

        const persisted = Model.intent.overlayFilters ?? {};
        this._filters = {
            workspace: initialFilters?.workspace ?? persisted.workspace ?? null,
            app: initialFilters?.app ?? persisted.app ?? null,
            pinnedOnly: initialFilters?.pinnedOnly ?? persisted.pinnedOnly ?? false,
        };
        this._persistFilters();

        this._rows = [];
        this._scrollAccum = 0;
        this._scrollPos = 0;
        this._lastScrollStep = 0;
        this._snap = true;

        this._cancelled = false;

        this._overlayL = null;
        this._railL = null;
        this._bandL = null;
        this._rowL = null;

        this._fadeTop = null;
        this._fadeBottom = null;

        this._rail = null;
        this._railTicksBox = null;
        this._railTicks = [];
        this._railMarker = null;
        this._railTip = null;
        this._railGrab = null;
        this._railDragging = false;
        this._railH = 0;
        this._railPad = 0;

        this._filterBar = null;
        this._openChipMenu = null;
        this._chipL = null;

        this._buildUI();
        this._initialKey = this._focusedWindow ?? null;

        this._smooth = new Smoother(this._scope, {
            onFrame: v => { this._scrollPos = v; this._layoutRows(); },
        });

        this._onSearchChanged();
        this._open();
    }

    _trackFullscreen() { return false; }
    _getRestoreKey(item) { return item.window; }
    _shouldCloseOnWindowRemoved(window) {
        return this._items.some(item => item.window === window);
    }

    _persistFilters() { Model.setIntent({ overlayFilters: { ...this._filters } }); }

    _hasActiveFilter() {
        return this._filters.workspace !== null
            || this._filters.app !== null
            || this._filters.pinnedOnly
            || (this._entry?.get_text?.().length ?? 0) > 0;
    }

    _applyFilters(items) {
        const f = this._filters;
        let list = items;
        if (f.workspace !== null) {
            list = list.filter(item => {
                try { return item.window.get_workspace()?.index() === f.workspace; }
                catch (e) { return false; }
            });
        }
        if (f.app !== null) list = list.filter(item => item.appId === f.app);
        if (f.pinnedOnly) list = list.filter(item => SelectedWindows.isWindowSelected(item.window));
        return list;
    }

    _matchItem(query, item) {
        const r = Fuzzy.fuzzyMatch(query, `${item.title} ${item.appName}`);
        if (!r.matched) return r;
        return { ...r, indices: new Set([...r.indices].filter(i => i < item.title.length)) };
    }

    _computeResults(query) {
        const filtered = this._applyFilters(this._items);

        if (query) {
            const scored = [];
            for (const item of filtered) {
                const r = this._matchItem(query, item);
                if (r.matched) scored.push({ ...item, score: r.score, indices: r.indices });
            }
            return scored.sort((a, b) => b.score - a.score);
        }

        // No query: input order (MRU + manual from model) is already correct.
        return filtered.map(item => ({ ...item, indices: null }));
    }

    _getAppName(window) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        return app ? app.get_name() : (window.get_wm_class() || 'Unknown');
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        this._monitor = monitor;
        this._overlayL = computeOverlayLayout(monitor);
        this._railL = computeRailLayout(this._overlayL);
        this._bandL = computeBandLayout(this._overlayL, this._railL);
        this._rowL = computeRowLayout(this._overlayL, this._bandL);

        const OV = this._overlayL;
        const BAND = this._bandL;

        this._container = UI.createFullscreenContainer(this._overlayL, 'window-selector-overlay');
        this._container.add_style_class_name('search-mode');

        const size = { width: OV.width, height: OV.height };
        this._tint = new St.Widget({ style_class: 'selector-tint', reactive: false, opacity: 255, ...size });
        this._listLayer = new St.Widget(size);

        this._fadeTop = new St.Widget({ style_class: 'selector-fade-top', reactive: false });
        this._fadeBottom = new St.Widget({ style_class: 'selector-fade-bottom', reactive: false });
        this._resizeBackdrop(this._items.length);

        const { band, titleBin } = UI.createSelectionBand(BAND);
        this._bandBin = titleBin;
        this._band = band;

        const controls = new St.BoxLayout({
            vertical: true, width: BAND.searchWidth, style: 'spacing: 16px;',
        });

        const search = UI.createSearchField({ width: BAND.searchWidth, hint: 'Type to search…' });
        this._wireEntry(search.entry);
        search.entry.set_style(`font-size: ${S.selector.search}px;`);
        if (search.entry.primary_icon) search.entry.primary_icon.visible = false;
        this._searchRoot = search.actor;
        controls.add_child(search.actor);

        this._filterBar = new St.BoxLayout({
            style_class: 'selector-filter-bar',
            width: BAND.searchWidth, height: BAND.filterHeight,
        });
        controls.add_child(this._filterBar);

        band.add_child(new St.Bin({
            x_expand: true, x_align: Clutter.ActorAlign.CENTER, child: controls,
        }));

        const gap = S.selector.filterRowGap;
        const remaining = BAND.searchWidth - gap * 3;
        const unitW = Math.floor(remaining / 5);
        this._chipL = { gap, resetW: unitW * 2, slotW: unitW, chipH: S.selector.filterChipH };
        this._refreshFilterBar();

        for (const actor of [this._tint, this._fadeTop, this._fadeBottom, this._listLayer, band])
            this._container.add_child(actor);

        this._buildRail();

        this._scope.connect(this._container, 'scroll-event', (a, e) => this._onScroll(e));
        this._scope.connect(this._container, 'button-release-event', (a, e) => this._onClick(e));

        this._scope.connect(global.stage, 'notify::key-focus', () => {
            if (this._closed || this._closing) return;
            if (global.stage.get_key_focus() === this._entry.clutter_text) return;
            this._refocusEntry();
        });
    }

    _resizeBackdrop(n) {
        if (!this._fadeTop) return;
        const BAND = this._bandL, ROW = this._rowL;
        const rows = rowsEachSideFor(n);
        const h = rows * ROW.slotH;
        this._fadeTop.visible = this._fadeBottom.visible = rows > 0;
        if (!rows) return;
        this._fadeTop.set_position(BAND.x, BAND.y - h);
        this._fadeTop.set_size(BAND.width, h);
        this._fadeBottom.set_position(BAND.x, BAND.y + BAND.height);
        this._fadeBottom.set_size(BAND.width, h);
    }

    _noEllipsis(lbl) {
        lbl.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        lbl.clutter_text.set_line_wrap(false);
        return lbl;
    }

    _fitSize(text, size, maxW, floor = 0.6) {
        const est = [...text].length * size * 0.58;
        if (est <= maxW) return size;
        return Math.max(Math.round(size * floor), Math.floor(size * maxW / est));
    }

    _refreshFilterBar() {
        if (!this._filterBar || !this._chipL) return;
        this._filterBar.destroy_all_children();
        this._openChipMenu = null;
        const { gap } = this._chipL;
        const chipBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style: `spacing: ${gap}px;`,
        });
        chipBox.add_child(this._makeResetChip());
        chipBox.add_child(this._makeWorkspaceChip());
        chipBox.add_child(this._makeAppChip());
        chipBox.add_child(this._makePinnedChip());
        this._filterBar.add_child(chipBox);
    }

    _makeChip({ cls, label = null, value, active = false, greyed = false,
        width = null, fitFloor = 0.6, onClick, onMenu = null, onScroll = null }) {
        const { slotW, chipH } = this._chipL;
        const w = width ?? slotW;
        const btn = new St.Button({
            style_class: `selector-filter-chip ${cls}`,
            reactive: true, track_hover: true, clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
            width: w, height: chipH,
        });
        if (active) btn.add_style_class_name('active');
        if (greyed) btn.add_style_class_name('greyed');

        const col = new St.BoxLayout({
            style_class: 'selector-filter-chip-box', vertical: true,
            x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        if (label) {
            const l = new St.Label({
                text: label.toUpperCase(),
                style_class: 'selector-filter-label',
                x_align: Clutter.ActorAlign.CENTER,
            });
            l.set_style(`font-size: ${S.selector.filterLabelText}px;`);
            col.add_child(this._noEllipsis(l));
        }
        const v = new St.Label({
            text: value, style_class: 'selector-filter-value',
            x_align: Clutter.ActorAlign.CENTER,
        });
        v.set_style(`font-size: ${this._fitSize(value, S.selector.filterText, w - 40, fitFloor)}px;`);
        col.add_child(this._noEllipsis(v));
        btn.set_child(col);

        const scope = this._rowsScope;
        scope.connect(btn, 'clicked', onClick);
        if (onMenu) scope.connect(btn, 'button-press-event', (a, e) => {
            if (e.get_button() === Clutter.BUTTON_SECONDARY) { onMenu(btn); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });
        if (onScroll) scope.connect(btn, 'scroll-event', (a, e) => {
            const d = this._scrollDir(e);
            if (!d) return Clutter.EVENT_PROPAGATE;
            onScroll(d);
            return Clutter.EVENT_STOP;
        });
        return btn;
    }

    _makeResetChip() {
        const n = this._results.length;
        return this._makeChip({
            cls: 'selector-filter-reset',
            value: `↺ Reset (${n})`,
            width: this._chipL.resetW,
            fitFloor: 0.45,
            greyed: !this._hasActiveFilter(),
            onClick: () => { if (this._hasActiveFilter()) this._resetFilters(); },
        });
    }

    _makeWorkspaceChip() {
        const ws = this._filters.workspace;
        return this._makeChip({
            cls: 'selector-filter-workspace',
            label: 'Workspace',
            value: ws === null ? 'None' : `${ws + 1} · ${this._workspaceNameForChip(ws)}`,
            active: ws !== null,
            onClick: () => this._cycleWorkspace(1),
            onMenu: btn => this._showWorkspaceMenu(btn),
            onScroll: d => this._cycleWorkspace(d),
        });
    }

    _makeAppChip() {
        let value = 'None';
        if (this._filters.app !== null) {
            const item = this._items.find(i => i.appId === this._filters.app);
            value = item ? item.appName : 'None';
        }
        return this._makeChip({
            cls: 'selector-filter-app',
            label: 'App',
            value,
            active: this._filters.app !== null,
            onClick: () => this._cycleApp(1),
            onMenu: btn => this._showAppMenu(btn),
            onScroll: d => this._cycleApp(d),
        });
    }

    _makePinnedChip() {
        const count = SelectedWindows.selectedCount();
        const on = this._filters.pinnedOnly;
        const chip = this._makeChip({
            cls: 'selector-filter-pinned',
            label: 'Pinned',
            value: on ? `Only · ${count}` : (count === 0 ? 'None' : String(count)),
            greyed: count === 0 && !on,
            onClick: () => {
                if (this._filters.pinnedOnly) {
                    this._filters.pinnedOnly = false;
                } else {
                    this._filters.workspace = null;
                    this._filters.app = null;
                    this._filters.pinnedOnly = true;
                }
                this._applyFiltersAndRefresh();
            },
        });
        if (on) chip.add_style_class_name('pinned-mode');
        return chip;
    }

    _scrollDir(event) {
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP) return -1;
        if (dir === Clutter.ScrollDirection.DOWN) return 1;
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            return Math.sign(dy);
        }
        return 0;
    }

    _cycleWorkspace(dir) {
        const n = Model.WorkspaceManager.n_workspaces;
        const base = [null];
        for (let i = 0; i < n; i++) base.push(i);
        const i = base.indexOf(this._filters.workspace);
        this._filters.workspace = base[(i + dir + base.length) % base.length];
        this._applyFiltersAndRefresh();
    }

    _cycleApp(dir) {
        const apps = this._filterableApps();
        if (apps.length === 0) {
            this._filters.app = null;
            this._applyFiltersAndRefresh();
            return;
        }
        const values = [null, ...apps.map(a => a.id)];
        const i = values.indexOf(this._filters.app);
        this._filters.app = values[(i + dir + values.length) % values.length];
        this._applyFiltersAndRefresh();
    }

    _resetFilters() {
        this._filters.workspace = null;
        this._filters.app = null;
        this._filters.pinnedOnly = false;
        if (this._entry) this._entry.set_text('');
        this._applyFiltersAndRefresh();
    }

    _applyFiltersAndRefresh() {
        this._persistFilters();
        this._initialKey = null;
        this._onSearchChanged();
    }

    _workspaceNameForChip(index) {
        try { return Meta.prefs_get_workspace_name(index) || `Workspace ${index + 1}`; }
        catch (e) { return `Workspace ${index + 1}`; }
    }

    _showWorkspaceMenu(anchor) {
        const n = Model.WorkspaceManager.n_workspaces;
        const current = this._filters.workspace;
        Interactions.openContextMenu(anchor, menu => {
            menu.addAction('None', () => {
                this._filters.workspace = null;
                this._applyFiltersAndRefresh();
            });
            for (let i = 0; i < n; i++) {
                const marker = i === current ? ' ●' : '';
                menu.addAction(`${i + 1} · ${this._workspaceNameForChip(i)}${marker}`, () => {
                    this._filters.workspace = i;
                    this._applyFiltersAndRefresh();
                });
            }
        }, { onStateChange: (open) => { if (!open) this._openChipMenu = null; } });
        this._openChipMenu = 'workspace';
    }

    _showAppMenu(anchor) {
        const apps = this._filterableApps();
        const current = this._filters.app;
        Interactions.openContextMenu(anchor, menu => {
            menu.addAction('None', () => {
                this._filters.app = null;
                this._applyFiltersAndRefresh();
            });
            for (const a of apps) {
                const marker = a.id === current ? ' ●' : '';
                menu.addAction(`${a.name} (${a.count})${marker}`, () => {
                    this._filters.app = a.id;
                    this._applyFiltersAndRefresh();
                });
            }
        }, { onStateChange: (open) => { if (!open) this._openChipMenu = null; } });
        this._openChipMenu = 'app';
    }

    _filterableApps() {
        const counts = new Map();
        for (const item of this._items) {
            if (!item.appId) continue;
            counts.set(item.appId, (counts.get(item.appId) || 0) + 1);
        }
        const out = [];
        for (const [id, count] of counts) {
            if (count < 2) continue;
            const item = this._items.find(i => i.appId === id);
            out.push({ id, name: item?.appName || id, count });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    _buildRail() {
        const RL = this._railL;
        const ROW = this._rowL;
        this._railH = RL.height;
        this._railPad = RL.pad;

        this._rail = new St.Widget({
            style_class: 'selector-rail',
            reactive: true, track_hover: true,
            x: RL.x, y: RL.y, width: RL.width, height: RL.height,
        });

        const track = new St.Widget({
            style_class: 'selector-rail-track',
            x: Math.round((RL.width - 2) / 2),
            y: 0, width: 2, height: RL.height,
        });
        this._rail.add_child(track);

        this._railTicksBox = new St.Widget({ x: 0, y: 0, width: RL.width, height: RL.height });
        this._rail.add_child(this._railTicksBox);

        this._railMarker = new St.Widget({
            style_class: 'selector-rail-marker',
            x: Math.round((RL.width - S.selector.railMarkerW) / 2),
            y: 0, width: S.selector.railMarkerW, height: S.selector.railMarkerH,
        });
        this._rail.add_child(this._railMarker);

        const tipFontSize = S.selector.tip;
        this._railTip = new St.Label({
            style_class: 'selector-rail-tip', text: '',
            x: 0, y: 0, width: ROW.tipWidth, opacity: 0,
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
            if (this._railDragging) { this._railPointerFromEvent(e); return Clutter.EVENT_STOP; }
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

    _acquireRailGrab() {
        try {
            const grab = global.stage.grab(this._rail);
            if (grab) { this._railGrab = { dismiss: () => grab.dismiss() }; return; }
        } catch (e) { journal(`[rail] stage.grab failed: ${e.message}`); }
        try {
            const modal = Main.pushModal(this._rail, { actionMode: Shell.ActionMode.NORMAL });
            this._railGrab = { modal };
        } catch (e) {
            journal(`[rail] pushModal failed: ${e.message}`);
            this._railGrab = null;
            this._railDragging = false;
        }
    }

    _releaseRailGrab() {
        const g = this._railGrab;
        this._railGrab = null;
        if (!g) return;
        if (g.modal) { try { Main.popModal(g.modal); } catch (e) { /* gone */ } }
        else { try { g.dismiss(); } catch (e) { /* gone */ } }
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

        const W = this._railL.width;
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
        const RL = this._railL, OV = this._overlayL, BAND = this._bandL;
        this._railTip.set_text(`${item.appName} — ${item.title}`);
        const h = this._railTip.height > 0 ? this._railTip.height : 58;
        const tipX = Math.max(8, RL.x - this._railTip.width - 8);
        let tipY = RL.y + this._railY(idx) - Math.round(h / 2);
        if (tipY + h > BAND.y && tipY < BAND.y + BAND.height) {
            const above = BAND.y - h - 8;
            tipY = above >= 8 ? above : Math.min(BAND.y + BAND.height + 8, OV.height - h - 8);
        }
        tipY = clamp(tipY, 8, OV.height - h - 8);
        this._railTip.set_position(tipX, tipY);
        this._railTip.opacity = 255;
    }

    _hideRailTip() {
        if (this._railTip) this._railTip.opacity = 0;
    }

    _renderResults(results) {
        const OV = this._overlayL, ROW = this._rowL;
        this._releaseRailGrab();
        this._railDragging = false;
        this._hideRailTip();
        this._resizeBackdrop(results.length);
        this._refreshFilterBar();

        this._listLayer.destroy_all_children();
        this._rows = results.map((item, index) => {
            const row = UI.createWindowTitleRow({
                icon: item.icon, title: item.title, indices: item.indices,
                width: OV.width, height: ROW.slotH,
                iconSize: ROW.rowIconSize,
                labelSize: ROW.rowLabelSize,
                maxWidth: ROW.rowTextMax,
            });
            this._rowsScope.connect(row, 'button-press-event', (a, e) => {
                if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
                const state = e.get_state();
                if (state & Clutter.ModifierType.CONTROL_MASK) {
                    if (item.window) {
                        SelectedWindows.toggleWindow(item.window);
                        if (this._filters.pinnedOnly &&
                            SelectedWindows.selectedCount() === 0) {
                            this._filters.pinnedOnly = false;
                        }
                        this._applyFiltersAndRefresh();
                    }
                    return Clutter.EVENT_STOP;
                }
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

    _layoutRows() {
        const BAND = this._bandL, ROW = this._rowL;
        const pos = this._scrollPos;
        const a = BAND.y - ROW.slotH / 2;
        const b = BAND.y + BAND.height + ROW.slotH / 2;
        const mid = (a + b) / 2;
        const half = (b - a) / 2;

        this._rows.forEach((row, i) => {
            const d = i - pos;
            const x = Math.abs(d);
            if (x >= 2.8) { row.hide(); return; }
            let c, op;
            if (x < 1) {
                c = mid + d * half;
                op = neighborOpacity(1) * ease((x - 0.2) / 0.8);
            } else {
                c = d > 0 ? b + (x - 1) * ROW.slotH : a - (x - 1) * ROW.slotH;
                op = neighborOpacity(x);
            }
            if (op < 0.01) { row.hide(); return; }
            row.show();
            row.set_position(0, Math.round(c - ROW.slotH / 2));
            row.set_opacity(Math.round(op * 255));
            row.set_pivot_point(0.5, 0.5);
            row.set_scale(1, 1);
        });

        this._bandBin.opacity = Math.round(255 * ease(1 - Math.abs(this._selectedIndex - pos)));
        this._updateRailMarker();
    }

    _onSelectionChanged(index) {
        const BAND = this._bandL;

        if (index < 0) {
            Model.setIntent({ overlayPick: null });
            const label = new St.Label({
                text: this._query ? 'No matching windows' : 'No windows',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.set_style(`font-size: ${S.selector.search}px;`);
            this._bandBin.set_child(label);
            return;
        }

        const item = this._results[index];
        Model.setIntent({ overlayPick: item.window });

        this._bandBin.set_child(UI.createBandTitle({
            icon: item.icon,
            title: item.title,
            width: BAND.width,
            height: BAND.selectedHeight,
            iconSize: S.selector.bandIcon,
            labelSize: S.selector.center,
        }));

        if (this._snap || Motion.reduced()) {
            this._smooth.snap(index);
            this._snap = false;
        } else {
            this._smooth.to(index);
        }
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

    _refocusEntry() {
        this._scope.idle(() => {
            if (this._closed || this._closing) return GLib.SOURCE_REMOVE;
            this._entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _handleEscape() {
        if (this._closed || this._closing) return;
        if (this._entry.get_text().length > 0) {
            this._entry.set_text('');
            return;
        }
        this._cancelled = true;
        this._container.add_style_class_name('selector-cancelling');
        this._scope.timeout(Motion.dur('cancelFlash'), () => {
            if (!this._closed) this._close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onBeforeClose() {
        this._releaseRailGrab();
        this._railDragging = false;
        Model.setIntent({ overlayPick: null });
    }

    _handleExtraKeys(event, symbol) {
        const inEntry = global.stage.get_key_focus() === this._entry.clutter_text;
        const state = event.get_state();

        if (!inEntry && !(state & (Clutter.ModifierType.CONTROL_MASK |
            Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK))) {
            if (symbol === Clutter.KEY_BackSpace && this._entry.get_text().length > 0) {
                this._entry.grab_key_focus();
                this._entry.clutter_text.delete_text(this._entry.get_text().length - 1, -1);
                return Clutter.EVENT_STOP;
            }
            const uc = event.get_key_unicode();
            const code = typeof uc === 'string' ? uc.codePointAt(0) : uc;
            if (code && code >= 0x20 && code !== 0x7f) {
                this._entry.grab_key_focus();
                this._entry.clutter_text.insert_unichar(code);
                return Clutter.EVENT_STOP;
            }
        }

        if (symbol === Clutter.KEY_Page_Down) {
            this._selectIndex(Math.min(this._selectedIndex + 5, this._results.length - 1));
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Page_Up) {
            this._selectIndex(Math.max(this._selectedIndex - 5, 0));
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Home && !inEntry) {
            this._selectIndex(0);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_End && !inEntry) {
            this._selectIndex(this._results.length - 1);
            return Clutter.EVENT_STOP;
        }
        return undefined;
    }

    _onClick(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
        if (this._closing) return Clutter.EVENT_STOP;
        const src = event.get_source();
        if (this._filterBar && src && this._filterBar.contains(src)) return Clutter.EVENT_STOP;
        if (this._openChipMenu) { this._openChipMenu = null; return Clutter.EVENT_STOP; }
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

        this._closing = true;
        WorkspaceActions.navigateToWindow(item.window);

        Motion.fadeOut(this._container, { duration: 'overlayFade' });
        this._scope.timeout(Motion.dur('overlayFade') + 30, () => {
            if (!this._closed) this._close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _close() {
        if (this._closed) return;
        journal('[WindowSearchOverlay] Closing');
        super._close();
        this._items = [];
        this._rows = [];
    }
}