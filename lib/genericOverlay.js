// Dmenu/rofi-style picker over a list of strings, with optional argument
// controls (toggles / choice selectors). Reports the result through
// SearchOverlayBase._notifyResult as:
//     [...selectedLabels (original order), 'args::', ...argLines]
//
// List rendering:
//   • <= STRIP_THRESHOLD items: plain scroll list.
//   • >  STRIP_THRESHOLD items: flyout-style PagedStrip (slots, edge
//     labels, rail). Keyboard moves the cursor and centres it; the wheel
//     steps the cursor; the pointer only highlights.
//
// Layouts: compact panel (default) or fullscreen launcher (`fullscreen`).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Fuzzy from './fuzzy.js';
import * as UI from './ui.js';
import { PagedStrip, ROW_SLOT, VISIBLE_SLOTS } from './strip.js';

import { SearchOverlayBase, clamp } from './overlayBase.js';

const ARGS_MARKER = 'args::';

const ROW_HEIGHT = 88;
const ROW_ICON = 56;
const STRIP_THRESHOLD = 5;

// Strip geometry (inside the list host)
const EDGE_H = 40;
const RAIL_W = 48;
const RAIL_GAP = 12;
const STRIP_ROW_GAP = 12;          // ROW_SLOT minus row height
const STRIP_WANT_SLOTS = 5;

// Compact layout
const COMPACT_MAX_WIDTH = 1000;
const COMPACT_MAX_HEIGHT = 600;
const COMPACT_H_MARGIN = 100;
const COMPACT_V_MARGIN = 80;
const COMPACT_PADDING = 24;
const SPACING = 12;
const SEARCH_H = 90;               // estimate: entry + border

// Fullscreen layout
const FULLSCREEN_MARGIN = 24;
const FULLSCREEN_SEARCH_HEIGHT = 160;

// Controls / footer
const CONTROL_HEAD_H = 40;
const CONTROL_ROW_H = 64;
const CONTROL_SPACING = 6;         // matches .dmenu-controls
const FOOTER_H = 64;

export class GenericSearchOverlay extends SearchOverlayBase {
    constructor(items, settings, options = {}) {
        super(settings);
        this._multi = !!options.multi;
        this._onResult = options.onResult || null;
        this._hint = options.hint || null;
        this._fullscreen = !!options.fullscreen;
        this._checked = new Set();
        this._items = items.map(it => ({
            id: String(it.id ?? it.label ?? it),
            label: String(it.label ?? it),
            icon: it.icon || null,
        }));
        this._controls = (options.controls ?? []).map(c => ({
            kind: c.kind, label: c.label, options: c.options,
            enabled: false, selected: 0,
        }));

        this._rows = [];
        this._rowRegistry = new Map();   // item.id -> { row, badge }
        this._useStrip = this._items.length > STRIP_THRESHOLD;
        this._strip = null;
        this._centerOnSelect = true;
        this._wheelAccum = 0;
        this._summary = null;

        this._buildUI();
        this._open();
        // Populate after the container is on stage: the strip measures
        // its edge labels while laying out.
        this._onSearchChanged();
        this._updateSummary();
    }

    _trackFullscreen() { return false; }
    _getRestoreKey(item) { return item.id; }
    _shouldCloseOnWindowRemoved() { return false; }

    _computeResults(query) {
        if (!query) return this._items.map(it => ({ ...it, indices: null }));
        const scored = [];
        for (const item of this._items) {
            const r = Fuzzy.fuzzyMatch(query, item.label);
            if (r.matched) scored.push({ ...item, score: r.score, indices: r.indices });
        }
        return scored.sort((a, b) => b.score - a.score);
    }

    // ==================== UI construction ====================
    _controlsHeight() {
        const n = this._controls.length;
        return n ? CONTROL_HEAD_H + n * CONTROL_ROW_H + n * CONTROL_SPACING : 0;
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        this._monitor = monitor;
        if (this._fullscreen) this._buildFullscreenLayout(monitor);
        else this._buildCompactLayout(monitor);
    }

    _buildFullscreenLayout(monitor) {
        const margin = Math.max(FULLSCREEN_MARGIN, Math.round(monitor.height * 0.04));
        const searchW = Math.min(1100, monitor.width - margin * 2);
        const searchY = margin;
        const resultsY = searchY + FULLSCREEN_SEARCH_HEIGHT + 16;
        const fullX = margin;
        const fullW = monitor.width - margin * 2;

        const ctrlH = this._controlsHeight();
        const footH = this._multi ? FOOTER_H : 0;
        const bottomH = ctrlH + footH + ((ctrlH && footH) ? SPACING : 0);
        const resultsH = Math.max(240, monitor.height - resultsY - margin);
        const listH = Math.max(160, resultsH - (bottomH ? bottomH + 16 : 0));

        this._container = UI.createFullscreenContainer(monitor, 'launcher-overlay');

        const search = UI.createSearchField({
            width: searchW, hint: 'Type to filter…',
            x: Math.round((monitor.width - searchW) / 2), y: searchY,
        });
        this._wireEntry(search.entry);
        if (this._hint) search.entry.set_hint_text(this._hint);
        this._container.add_child(search.actor);

        const host = this._buildList(fullW, listH);
        host.set_position(fullX, resultsY);
        this._container.add_child(host);

        if (bottomH) {
            const bottom = new St.BoxLayout({
                vertical: true, width: fullW, style: `spacing: ${SPACING}px;`,
            });
            bottom.set_position(fullX, resultsY + listH + 16);
            const controls = this._buildControls();
            const footer = this._buildFooter();
            if (controls) bottom.add_child(controls);
            if (footer) bottom.add_child(footer);
            this._container.add_child(bottom);
        }
    }

    _buildCompactLayout(monitor) {
        const ctrlH = this._controlsHeight();
        const footH = this._multi ? FOOTER_H : 0;
        const children = 2 + (ctrlH ? 1 : 0) + (footH ? 1 : 0);
        const fixedH = COMPACT_PADDING * 2 + SEARCH_H + ctrlH + footH + (children - 1) * SPACING;
        const avail = monitor.height - COMPACT_V_MARGIN * 2;

        const panelW = Math.min(COMPACT_MAX_WIDTH, monitor.width - COMPACT_H_MARGIN * 2);
        const panelH = this._useStrip
            ? Math.min(avail, fixedH + EDGE_H * 2 + STRIP_WANT_SLOTS * ROW_SLOT)
            : Math.min(avail, COMPACT_MAX_HEIGHT + ctrlH + footH);
        const listH = Math.max(120, panelH - fixedH);
        const innerW = panelW - COMPACT_PADDING * 2;
        const panelX = Math.round(monitor.x + (monitor.width - panelW) / 2);
        const panelY = Math.round(monitor.y + (monitor.height - panelH) / 3);

        this._container = UI.createFullscreenContainer(monitor, 'dmenu-overlay');

        this._panel = new St.BoxLayout({
            style_class: 'dmenu-panel', vertical: true, reactive: true,
            x: panelX, y: panelY, width: panelW, height: panelH,
        });
        this._container.add_child(this._panel);

        const search = UI.createSearchField({ width: innerW, hint: 'Type to filter…' });
        this._wireEntry(search.entry);
        if (this._hint) search.entry.set_hint_text(this._hint);
        this._panel.add_child(search.actor);

        this._panel.add_child(this._buildList(innerW, listH));

        const controls = this._buildControls();
        if (controls) this._panel.add_child(controls);
        const footer = this._buildFooter();
        if (footer) this._panel.add_child(footer);

        // Click outside the panel closes (cancel).
        this._scope.connect(this._container, 'button-press-event', (a, e) => {
            if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            if (this._panel.contains(e.get_source())) return Clutter.EVENT_PROPAGATE;
            this._close();
            return Clutter.EVENT_STOP;
        });
    }

    // ---------- list area ----------
    _buildList(w, h) {
        this._listHost = new St.Widget({ clip_to_allocation: true, width: w, height: h });

        if (this._useStrip) this._buildStrip(w, h);
        else this._buildScroll(w, h);

        this._emptyLabel = new St.Label({
            text: 'No matching items', style_class: 'dmenu-empty',
            visible: false, width: w,
        });
        this._emptyLabel.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
        this._emptyLabel.set_position(0, 12);
        this._listHost.add_child(this._emptyLabel);
        return this._listHost;
    }

    _buildScroll(w, h) {
        this._listScroll = new St.ScrollView({
            style_class: 'launcher-scroll', overlay_scrollbars: false,
        });
        this._listScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._listScroll.set_size(w, h);

        this._listBox = new St.BoxLayout({
            style_class: 'dmenu-results-box', vertical: true, x_expand: true,
        });
        this._listScroll.set_child(this._listBox);
        this._listHost.add_child(this._listScroll);
    }

    _buildStrip(w, h) {
        const slots = clamp(Math.floor((h - EDGE_H * 2) / ROW_SLOT), 1, VISIBLE_SLOTS);
        const rowsH = slots * ROW_SLOT;
        this._stripRowsW = w - RAIL_W - RAIL_GAP;

        const upEl = new St.Widget({ style_class: 'ws-flyout-edge ws-flyout-edge-up' });
        const downEl = new St.Widget({ style_class: 'ws-flyout-edge ws-flyout-edge-down' });
        const rowsEl = new St.Widget({ clip_to_allocation: true });
        const rail = UI.createRail();

        upEl.set_position(0, 0);
        upEl.set_size(w, EDGE_H);
        rowsEl.set_position(0, EDGE_H);
        rowsEl.set_size(this._stripRowsW, rowsH);
        rail.root.set_position(w - RAIL_W, EDGE_H);
        rail.root.set_size(RAIL_W, rowsH);       // before setItems: ticks read it
        downEl.set_position(0, EDGE_H + rowsH);
        downEl.set_size(w, EDGE_H);

        for (const a of [upEl, downEl, rail.root, rowsEl]) this._listHost.add_child(a);

        this._strip = new PagedStrip({
            rowsEl, upEl, downEl, rail,
            makeRow: (item, index) => this._makeRowActor(item, index, {
                width: this._stripRowsW, height: ROW_SLOT - STRIP_ROW_GAP,
            }),
            alive: () => !this._closed,
        });
        this._strip.setMaxSlots(slots);
        this._strip.setViewport(h);

        this._scope.connect(this._listHost, 'scroll-event', (a, e) => this._onWheel(e));
    }

    _onWheel(event) {
        let step = 0;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP) step = -1;
        else if (dir === Clutter.ScrollDirection.DOWN) step = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            this._wheelAccum += dy;
            if (Math.abs(this._wheelAccum) >= 1) {
                step = Math.sign(this._wheelAccum);
                this._wheelAccum = 0;
            }
        } else return Clutter.EVENT_PROPAGATE;

        if (step && this._results.length)
            this._selectIndex(clamp(this._selectedIndex + step, 0, this._results.length - 1));
        return Clutter.EVENT_STOP;
    }

    // ---------- controls ----------
    _buildControls() {
        if (!this._controls.length) return null;
        const n = this._controls.length;

        const box = new St.BoxLayout({ style_class: 'dmenu-controls', vertical: true, x_expand: true });

        const head = new St.BoxLayout({ height: CONTROL_HEAD_H, x_expand: true });
        head.add_child(new St.Label({
            text: 'OPTIONS', style_class: 'dmenu-section-label',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        }));
        head.add_child(new St.Label({
            text: `${n} control${n === 1 ? '' : 's'}`, style_class: 'dmenu-section-count',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(head);

        for (const c of this._controls) box.add_child(this._buildControlRow(c));
        return box;
    }

    _buildControlRow(c) {
        const row = new St.BoxLayout({
            style_class: 'dmenu-control-row', x_expand: true,
            height: CONTROL_ROW_H, reactive: true, track_hover: true,
        });
        const name = new St.Label({
            text: c.label, style_class: 'dmenu-control-name',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        name.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        row.add_child(name);

        if (c.kind === 'toggle') {
            const sw = new PopupMenu.Switch(c.enabled);
            sw.y_align = Clutter.ActorAlign.CENTER;
            row.add_child(sw);
            this._scope.connect(row, 'button-press-event', (a, e) => {
                if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
                c.enabled = !c.enabled;
                sw.state = c.enabled;
                this._entry.grab_key_focus();
                return Clutter.EVENT_STOP;
            });
            return row;
        }

        const seg = new St.BoxLayout({
            style_class: 'dmenu-segmented', y_align: Clutter.ActorAlign.CENTER,
        });
        const buttons = [];
        const sync = () => buttons.forEach((b, i) => {
            if (i === c.selected) b.add_style_class_name('active');
            else b.remove_style_class_name('active');
        });
        c.options.forEach((opt, i) => {
            const b = new St.Button({
                label: opt.label, style_class: 'dmenu-segment',
                can_focus: false, reactive: true, track_hover: true,
            });
            this._scope.connect(b, 'clicked', () => {
                c.selected = i;
                sync();
                this._entry.grab_key_focus();
            });
            buttons.push(b);
            seg.add_child(b);
        });
        sync();
        row.add_child(seg);
        return row;
    }

    _collectArgs() {
        const out = [];
        for (const c of this._controls) {
            const opt = c.kind === 'toggle' ? (c.enabled ? c.options[0] : null) : c.options[c.selected];
            const arg = opt?.arg?.trim();
            if (arg) out.push(arg);
        }
        return out;
    }

    // ---------- footer (multi only) ----------
    _buildFooter() {
        if (!this._multi) return null;
        const box = new St.BoxLayout({ style_class: 'dmenu-footer', x_expand: true, height: FOOTER_H });
        this._summary = new St.Label({
            style_class: 'dmenu-summary', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        const confirm = new St.Button({
            label: 'Confirm selection ↵', style_class: 'dmenu-confirm',
            can_focus: false, reactive: true, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._scope.connect(confirm, 'clicked', () => this._confirm());
        box.add_child(this._summary);
        box.add_child(confirm);
        return box;
    }

    _updateSummary() {
        if (!this._summary) return;
        this._summary.set_text(`${this._checked.size} selected · click or Ctrl+Space to toggle`);
    }

    _confirm() {
        this._finish(this._results[this._selectedIndex] ?? null);
    }

    // ==================== rows ====================
    _makeRowActor(item, index, { width = null, height }) {
        const props = {
            style_class: 'dmenu-result-row', x_expand: true,
            reactive: true, track_hover: true, height,
        };
        if (width) props.width = width;
        const row = new St.BoxLayout(props);

        if (item.icon) {
            row.add_child(new St.Icon({
                gicon: item.icon, icon_size: ROW_ICON,
                y_align: Clutter.ActorAlign.CENTER, style: 'margin-right: 16px;',
            }));
        }

        const label = new St.Label({
            style_class: 'dmenu-result-label', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        label.clutter_text.set_markup(UI.highlightMarkup(item.label, item.indices));
        row.add_child(label);

        let badge = null;
        if (this._multi) {
            badge = new St.Label({
                text: '', style_class: 'dmenu-badge', y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(badge);
        }
        this._applyChecked(row, badge, item.id);

        this._rowRegistry.set(item.id, { row, badge });
        row.connect('destroy', () => {
            if (this._rowRegistry.get(item.id)?.row === row) this._rowRegistry.delete(item.id);
        });

        row.connect('button-press-event', (a, e) => {
            if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            this._onRowClick(index);
            return Clutter.EVENT_STOP;
        });
        // Motion (not notify::hover): rows re-laid-out under a parked
        // pointer must not steal the keyboard cursor.
        row.connect('motion-event', () => {
            if (this._closed || this._selectedIndex === index) return Clutter.EVENT_PROPAGATE;
            this._centerOnSelect = false;
            this._selectIndex(index);
            this._centerOnSelect = true;
            return Clutter.EVENT_PROPAGATE;
        });
        return row;
    }

    _applyChecked(row, badge, id) {
        const on = this._checked.has(id);
        if (on) row.add_style_class_name('selected');
        else row.remove_style_class_name('selected');
        if (badge) { badge.set_text(on ? '✓' : ''); badge.visible = on; }
    }

    _onRowClick(index) {
        this._centerOnSelect = false;
        this._selectIndex(index);
        this._centerOnSelect = true;
        if (this._multi) this._toggleAt(index);
        else this._activateResult(index);
    }

    _renderResults(results) {
        this._rowRegistry.clear();
        if (this._emptyLabel) this._emptyLabel.visible = results.length === 0;

        if (this._useStrip) {
            this._strip.setItems(results, 0);
            return;
        }

        this._listBox.destroy_all_children();
        this._rows = [];
        results.forEach((item, i) => {
            const row = this._makeRowActor(item, i, { height: ROW_HEIGHT });
            this._listBox.add_child(row);
            this._rows.push(row);
        });
    }

    _onSelectionChanged(index) {
        if (this._useStrip) {
            this._strip.setHighlight(index);
            if (index >= 0 && this._centerOnSelect) this._strip.center(index);
            return;
        }

        for (let i = 0; i < this._rows.length; i++) {
            if (i === index) this._rows[i].add_style_class_name('sel');
            else this._rows[i].remove_style_class_name('sel');
        }
        if (index < 0) return;

        this._scope.idle(() => {
            if (this._closed || index < 0) return GLib.SOURCE_REMOVE;
            const row = this._rows[index];
            const adj = this._listScroll.vadjustment;
            if (!row || !adj) return GLib.SOURCE_REMOVE;
            const box = row.get_allocation_box();
            const v = adj.value, page = adj.page_size;
            let target = null;
            if (box.y1 < v) target = box.y1;
            else if (box.y2 > v + page) target = box.y2 - page;
            if (target == null) return GLib.SOURCE_REMOVE;
            target = Math.max(adj.lower, Math.min(target, adj.upper - page));
            if (target !== v) adj.ease(target, { duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            return GLib.SOURCE_REMOVE;
        });
    }

    // ==================== selection ====================
    _updateCheckmarks() {
        for (const [id, { row, badge }] of this._rowRegistry)
            this._applyChecked(row, badge, id);
        this._updateSummary();
    }

    _toggleAt(index) {
        const item = this._results[index];
        if (!item) return;
        if (this._checked.has(item.id)) this._checked.delete(item.id);
        else this._checked.add(item.id);
        this._updateCheckmarks();
    }

    _handleExtraKeys(event, symbol) {
        const state = event.get_state();

        if (symbol === Clutter.KEY_Page_Down) {
            if (this._results.length)
                this._selectIndex(Math.min(this._selectedIndex + 5, this._results.length - 1));
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Page_Up) {
            if (this._results.length) this._selectIndex(Math.max(this._selectedIndex - 5, 0));
            return Clutter.EVENT_STOP;
        }

        if (!this._multi) return undefined;

        if (symbol === Clutter.KEY_Tab) {
            this._toggleAt(this._selectedIndex);
            this._selectIndex(this._selectedIndex + 1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_space && (state & Clutter.ModifierType.CONTROL_MASK)) {
            this._toggleAt(this._selectedIndex);
            return Clutter.EVENT_STOP;
        }
        if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) &&
            (state & Clutter.ModifierType.SHIFT_MASK)) {
            this._toggleAt(this._selectedIndex);
            this._selectIndex(this._selectedIndex + 1);
            return Clutter.EVENT_STOP;
        }
        return undefined;
    }

    _handleEscape() {
        if (this._entry.get_text().length > 0) { this._entry.set_text(''); return; }
        this._close();
    }

    // ==================== result ====================
    _activateFocused() {
        if (this._selectedIndex >= 0) this._activateResult(this._selectedIndex);
        else if (this._checked.size > 0) this._finish(null);
        else if (this._query) {
            this._notifyResult([this._query, ARGS_MARKER, ...this._collectArgs()]);
            this._close();
        }
    }

    _activateResult(index) {
        this._finish(this._results[index] ?? null);
    }

    // Record format: selected values in ORIGINAL item order, then the
    // reserved `args::` marker, then one line per active argument.
    _finish(item) {
        if (this._closed) return;
        const checked = this._items.filter(it => this._checked.has(it.id));
        const chosen = checked.length ? checked : (item ? [item] : []);
        const labels = chosen.map(it => it.label).filter(Boolean);
        if (labels.length === 0) return;

        this._notifyResult([...labels, ARGS_MARKER, ...this._collectArgs()]);
        this._close();
    }

    _onBeforeClose() {
        this._strip?.destroy();
        this._strip = null;
    }
}