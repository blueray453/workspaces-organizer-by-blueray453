// ===== FILE: ./lib/genericOverlay.js =====
// Dmenu/rofi-style picker over a list of strings. Reports the user's
// choice through SearchOverlayBase._notifyResult.
//
// Two layouts, selected by the `fullscreen` option:
//   • fullscreen=false  — a compact 1000×600 panel, centred near the
//                         top of the screen, with a light tint behind
//                         it. Click outside the panel cancels.
//   • fullscreen=true   — the TopNotch launcher layout: search field
//                         anchored to the top edge, results below,
//                         semi-opaque full-screen backing.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Fuzzy from './fuzzy.js';
import * as UI from './ui.js';

import { SearchOverlayBase, clamp } from './overlayBase.js';

const ROW_HEIGHT = 88;
const ROW_ICON = 56;
const MARKER_W = 40;

// Compact layout dimensions, matching the SimpleDmenu defaults.
const COMPACT_MAX_WIDTH = 1000;
const COMPACT_MAX_HEIGHT = 600;
const COMPACT_H_MARGIN = 100;
const COMPACT_V_MARGIN = 150;
const COMPACT_PADDING = 24;

// Fullscreen layout (launcher-style) dimensions.
const FULLSCREEN_MARGIN = 24;
const FULLSCREEN_SEARCH_HEIGHT = 160;

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
        this._rows = [];
        this._rowMeta = [];

        this._buildUI();
        this._onSearchChanged();
        this._open();
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
        const resultsH = Math.max(240, monitor.height - resultsY - margin);
        const fullX = margin;
        const fullW = monitor.width - margin * 2;

        this._container = UI.createFullscreenContainer(monitor, 'launcher-overlay');

        const search = UI.createSearchField({
            width: searchW, hint: 'Type to filter…',
            x: Math.round((monitor.width - searchW) / 2),
            y: searchY,
        });
        this._wireEntry(search.entry);
        if (this._hint) search.entry.set_hint_text(this._hint);
        this._container.add_child(search.actor);

        this._listScroll = new St.ScrollView({
            style_class: 'launcher-scroll',
            x_expand: true, y_expand: true, overlay_scrollbars: false,
        });
        this._listScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._listScroll.set_position(fullX, resultsY);
        this._listScroll.set_size(fullW, resultsH);

        this._listBox = new St.BoxLayout({
            style_class: 'dmenu-results-box',
            vertical: true, x_expand: true,
        });
        this._listScroll.set_child(this._listBox);
        this._container.add_child(this._listScroll);
    }

    _buildCompactLayout(monitor) {
        const panelW = Math.min(COMPACT_MAX_WIDTH,
            monitor.width - COMPACT_H_MARGIN * 2);
        const panelH = Math.min(COMPACT_MAX_HEIGHT,
            monitor.height - COMPACT_V_MARGIN * 2);
        const panelX = Math.round(monitor.x + (monitor.width - panelW) / 2);
        const panelY = Math.round(monitor.y + monitor.height / 6);
        const innerW = panelW - COMPACT_PADDING * 2;

        this._container = UI.createFullscreenContainer(monitor, 'dmenu-overlay');

        this._panel = new St.BoxLayout({
            style_class: 'dmenu-panel',
            vertical: true,
            reactive: true,
            x: panelX, y: panelY,
            width: panelW, height: panelH,
        });
        this._container.add_child(this._panel);

        const search = UI.createSearchField({
            width: innerW, hint: 'Type to filter…',
        });
        this._wireEntry(search.entry);
        if (this._hint) search.entry.set_hint_text(this._hint);
        this._panel.add_child(search.actor);

        this._listScroll = new St.ScrollView({
            style_class: 'launcher-scroll',
            x_expand: true, y_expand: true, overlay_scrollbars: false,
        });
        this._listScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._panel.add_child(this._listScroll);

        this._listBox = new St.BoxLayout({
            style_class: 'dmenu-results-box',
            vertical: true, x_expand: true,
        });
        this._listScroll.set_child(this._listBox);

        // Click outside the panel closes (cancel).
        this._scope.connect(this._container, 'button-press-event', (a, e) => {
            if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            const src = e.get_source();
            if (this._panel.contains(src)) return Clutter.EVENT_PROPAGATE;
            this._close();
            return Clutter.EVENT_STOP;
        });
    }

    // ==================== results ====================
    _renderResults(results) {
        this._listBox.destroy_all_children();
        this._rows = [];
        this._rowMeta = [];

        for (let i = 0; i < results.length; i++) {
            const item = results[i];
            const row = new St.BoxLayout({
                style_class: 'dmenu-result-row',
                x_expand: true, reactive: true, track_hover: true,
                height: ROW_HEIGHT,
            });

            let check = null;
            if (this._multi) {
                check = new St.Label({
                    text: this._checked.has(item.id) ? '●' : '',
                    style_class: 'dmenu-marker',
                    y_align: Clutter.ActorAlign.CENTER,
                    width: MARKER_W,
                });
                row.add_child(check);
            }

            if (item.icon) {
                row.add_child(new St.Icon({
                    gicon: item.icon,
                    icon_size: ROW_ICON,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'margin-right: 16px;',
                }));
            }

            const label = new St.Label({
                style_class: 'dmenu-result-label',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            label.clutter_text.set_markup(UI.highlightMarkup(item.label, item.indices));
            row.add_child(label);

            this._rowsScope.connect(row, 'button-press-event', (a, e) => {
                if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
                this._selectIndex(i);
                this._activateResult(i);
                return Clutter.EVENT_STOP;
            });
            this._rowsScope.connect(row, 'notify::hover', () => {
                if (row.hover) this._selectIndex(i);
            });

            this._listBox.add_child(row);
            this._rows.push(row);
            this._rowMeta.push({ row, check, label });
        }
    }

    _onSelectionChanged(index) {
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

    _updateCheckmarks() {
        for (let i = 0; i < this._rowMeta.length; i++) {
            const meta = this._rowMeta[i];
            const item = this._results[i];
            if (!meta.check || !item) continue;
            meta.check.set_text(this._checked.has(item.id) ? '●' : '');
        }
    }

    _toggleAt(index) {
        const item = this._results[index];
        if (!item) return;
        if (this._checked.has(item.id)) this._checked.delete(item.id);
        else this._checked.add(item.id);
        this._updateCheckmarks();
    }

    _handleExtraKeys(event, symbol) {
        if (!this._multi) return undefined;
        const state = event.get_state();

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

    _activateFocused() {
        if (this._selectedIndex >= 0) this._activateResult(this._selectedIndex);
        else if (this._query) { this._notifyResult([this._query]); this._close(); }
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (!item) return;
        const chosen = this._results.filter(it => this._checked.has(it.id));
        if (chosen.length === 0) chosen.push(item);
        const labels = chosen.map(it => it.label).filter(Boolean);
        this._notifyResult(labels.length > 0 ? labels : null);
        this._close();
    }
}