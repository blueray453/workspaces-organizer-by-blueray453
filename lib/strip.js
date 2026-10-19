// The prototype's createStrip(): a fixed number of visible slots, a view
// position that scrolls by whole rows, edge hold zones with acceleration,
// and a rail with ticks + marker. Used by the anchored flyout.

import GLib from 'gi://GLib';
import St from 'gi://St';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const ROW_SLOT = 46;
export const VISIBLE_SLOTS = 7;
const HALF = Math.floor(VISIBLE_SLOTS / 2);
const RAIL_PAD = 10;
const DEAD = 0.06;

const speedWord = t => (t < 0.25 ? 'SLOW' : t < 0.6 ? 'MEDIUM' : 'FAST');
const depthToT = d => Math.max(0, (d - DEAD) / (1 - DEAD));
const edgeSpeed = d => {
    const t = depthToT(d);
    return t <= 0 ? 0 : 0.8 + 30 * t * t;
};

export class PagedStrip {
    constructor({ rowsEl, upEl, downEl, rail, makeRow, onEdgeStart = null, alive = null }) {
        this._rowsEl = rowsEl;
        this._upEl = upEl;
        this._downEl = downEl;
        this._rail = rail;
        this._makeRow = makeRow;
        this._onEdgeStart = onEdgeStart;
        this._alive = alive ?? (() => true);

        const upLabel = new St.Label({ style_class: 'ws-flyout-edge-label' });
        upLabel.set_x_align(ClutterAlign.CENTER);
        upLabel.set_y_align(ClutterAlign.END);
        upEl.set_child(upLabel);
        this._upLabel = upLabel;

        const downLabel = new St.Label({ style_class: 'ws-flyout-edge-label' });
        downLabel.set_x_align(ClutterAlign.CENTER);
        downLabel.set_y_align(ClutterAlign.START);
        downEl.set_child(downLabel);
        this._downLabel = downLabel;

        this._items = [];
        this._rowEls = new Map();
        this._view = 0;
        this._highlight = -1;
        this._slots = 1;
        this._hostH = 0;
        this._edgeDir = 0;
        this._edgeDepth = 0;
        this._raf = 0;
        this._last = 0;
        this._zoneText = { up: '', down: '' };
        this._zoneAlpha = { up: -1, down: -1 };
    }

    get count() { return this._items.length; }
    get highlighted() { return this._highlight; }
    get selectedIndex() { return Math.max(0, this._highlight); }
    scrolling() { return this._edgeDir !== 0; }

    setViewport(height) { this._hostH = height; }

    setItems(items, startIndex = 0) {
        this.stopEdge();
        this._items = items;
        this._slots = Math.min(VISIBLE_SLOTS, Math.max(1, items.length));
        this._rowsEl.set_height(this._slots * ROW_SLOT);

        for (const [, el] of this._rowEls) el.destroy();
        this._rowEls.clear();

        this._view = this._clampV(Math.max(0, startIndex));
        this._highlight = Math.round(this._view);

        this._buildRail();
        this.layout();
    }

    _isStrip() { return this._items.length > VISIBLE_SLOTS; }
    _minV() { return this._isStrip() ? HALF : (this._items.length - 1) / 2; }
    _maxV() { return this._isStrip() ? this._items.length - 1 - HALF : (this._items.length - 1) / 2; }
    _clampV(v) { return clamp(v, this._minV(), this._maxV()); }

    // ---------- rail ----------
    _railY(p) {
        const h = this._rail.root.height;
        if (this._items.length <= 1) return h / 2;
        const span = Math.max(1, h - RAIL_PAD * 2);
        return RAIL_PAD + (p / (this._items.length - 1)) * span;
    }

    _buildRail() {
        this._rail.ticks.destroy_all_children();
        this._rail.root.visible = this._isStrip();
        if (!this._isStrip()) return;

        const w = this._rail.root.width;
        this._items.forEach((it, i) => {
            const tick = new St.Widget({
                style_class: 'ws-flyout-rail-tick',
                x: Math.round((w - 10) / 2),
                y: Math.round(this._railY(i)) - 1,
                width: 10, height: 3,
            });
            tick.set_style(`background-color: ${it.color || '#93a1a1'};`);
            this._rail.ticks.add_child(tick);
        });
        this._updateMarker();
    }

    _updateMarker() {
        const marker = this._rail.marker;
        if (!marker) return;
        if (!this._isStrip()) { marker.visible = false; return; }
        marker.visible = true;

        const p = clamp(this._view, 0, Math.max(0, this._items.length - 1));
        const lo = Math.floor(p);
        const hi = Math.min(this._items.length - 1, lo + 1);
        const y = this._railY(lo) + (this._railY(hi) - this._railY(lo)) * (p - lo);
        marker.y = Math.round(y - marker.height / 2);
    }

    // ---------- rows ----------
    layout() {
        const R = this._items.length;
        const vis = this._slots;
        const lo = this._isStrip() ? Math.max(0, Math.floor(this._view - HALF - 1)) : 0;
        const hi = this._isStrip() ? Math.min(R - 1, Math.ceil(this._view + HALF + 1)) : R - 1;

        for (const [r, el] of [...this._rowEls]) {
            if (r < lo || r > hi) { el.destroy(); this._rowEls.delete(r); }
        }

        for (let r = lo; r <= hi; r++) {
            let el = this._rowEls.get(r);
            if (!el) {
                el = this._makeRow(this._items[r], r);
                this._rowEls.set(r, el);
                this._rowsEl.add_child(el);
            }
            const d = r - this._view;
            const ad = Math.abs(d);
            el.translation_y = Math.round((d + (vis - 1) / 2) * ROW_SLOT);

            const sel = r === this._highlight;
            if (sel) el.add_style_class_name('sel');
            else el.remove_style_class_name('sel');

            const op = this._isStrip()
                ? Math.max(0, 0.9 - 0.17 * ad) * clamp(HALF + 1 - ad, 0, 1)
                : 0.85;
            el.opacity = Math.round((sel ? 1 : op) * 255);
            el.show();
        }

        this._updateEdges();
        this._updateMarker();
    }

    setHighlight(i) {
        const idx = clamp(i, -1, Math.max(-1, this._items.length - 1));
        if (idx === this._highlight) return;
        this._highlight = idx;
        this.layout();
    }

    center(i) {
        this._view = this._clampV(i);
        this.layout();
    }

    // ---------- edges ----------
    _updateEdges() {
        const now = Math.round(this._view);
        const t = depthToT(this._edgeDepth);
        const above = this._isStrip() ? Math.max(0, now - HALF) : 0;
        const below = this._isStrip() ? Math.max(0, this._items.length - 1 - HALF - now) : 0;

        const apply = (which, el, label, count, dir, arrow, word) => {
            const active = this._edgeDir === dir;
            el.visible = count > 0;
            if (!el.visible) return;
            if (active) el.add_style_class_name('active');
            else el.remove_style_class_name('active');

            const text = `${arrow} ${count} more ${word}${active && t > 0 ? ' · ' + speedWord(t) : ''}`;
            if (this._zoneText[which] !== text) {
                this._zoneText[which] = text;
                label.set_text(text);
            }
            const alpha = active ? Math.round(clamp(t * 0.42, 0, 1) * 100) / 100 : 0;
            if (this._zoneAlpha[which] !== alpha) {
                this._zoneAlpha[which] = alpha;
                el.set_style(`background-color: rgba(42, 161, 152, ${alpha});`);
            }
        };

        apply('up', this._upEl, this._upLabel, above, -1, '▲', 'above');
        apply('down', this._downEl, this._downLabel, below, 1, '▼', 'below');
    }

    setEdge(dir, depth) {
        this._edgeDepth = depth;
        if (this._edgeDir !== dir) {
            this._edgeDir = dir;
            this._onEdgeStart?.();
        }
        if (!this._raf) {
            this._last = GLib.get_monotonic_time() / 1000;
            this._raf = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => this._step());
        }
        this._updateEdges();
    }

    stopEdge() {
        if (this._raf) { GLib.Source.remove(this._raf); this._raf = 0; }
        if (!this._edgeDir) return;
        this._edgeDir = 0;
        this._edgeDepth = 0;
        this._updateEdges();
        this._updateMarker();
    }

    _step() {
        this._raf = 0;
        if (!this._edgeDir) return GLib.SOURCE_REMOVE;
        if (!this._alive()) { this.stopEdge(); return GLib.SOURCE_REMOVE; }

        const now = GLib.get_monotonic_time() / 1000;
        const dt = Math.min(now - this._last, 60) / 1000;
        this._last = now;

        this._view = this._clampV(this._view + this._edgeDir * edgeSpeed(this._edgeDepth) * dt);
        const r = Math.round(this._view);
        if (r !== this._highlight) this._highlight = r;
        this.layout();

        if (this._view <= this._minV() || this._view >= this._maxV()) {
            this.stopEdge();
            return GLib.SOURCE_REMOVE;
        }
        this._raf = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => this._step());
        return GLib.SOURCE_REMOVE;
    }

    // ---------- pointer ----------
    /**
     * `y` is local to the flyout root. Returns the row index under the
     * pointer, or -1. Short groups (<= 7 rows) are fully hover-able: only
     * the edge-hold logic is gated on `_isStrip()`.
     */
    over(y) {
        const rowsTop = this._rowsEl.y;
        const rowsH = this._rowsEl.height;

        if (this._isStrip()) {
            if (y < rowsTop && this._view > this._minV() + 0.001) {
                this.setEdge(-1, clamp((rowsTop - y) / Math.max(1, rowsTop), 0, 1));
                return this._highlight;
            }
            if (y > rowsTop + rowsH && this._view < this._maxV() - 0.001) {
                const below = Math.max(1, this._hostH - rowsTop - rowsH);
                this.setEdge(1, clamp((y - rowsTop - rowsH) / below, 0, 1));
                return this._highlight;
            }
        }
        this.stopEdge();

        if (y < rowsTop - 2 || y > rowsTop + rowsH + 2) return -1;

        const idx = Math.round((y - rowsTop) / ROW_SLOT - (this._slots - 1) / 2 + this._view);
        if (idx < 0 || idx >= this._items.length) return -1;
        this.setHighlight(idx);
        return idx;
    }

    clearHover() { this.setHighlight(-1); }

    destroy() {
        this.stopEdge();
        for (const [, el] of this._rowEls) el.destroy();
        this._rowEls.clear();
        this._items = [];
    }
}

// St doesn't re-export Clutter's align enum through the St namespace on every
// version; pin it once here so the strip stays self-contained.
import Clutter from 'gi://Clutter';
const ClutterAlign = Clutter.ActorAlign;