// ===== FILE: ./lib/strip.js =====
// The prototype's createStrip(): a fixed number of visible slots, a view
// position that scrolls by whole rows, edge hold zones with acceleration,
// and a rail with ticks + marker.
//
// ROW_SLOT is sized so the enlarged flyout rows fit without clipping. All
// metrics that vary with BASE come from sizes.js; per-app tick colors come
// from theme.js.
//
// Two scroll paths coexist:
//   • setEdge() — pointer parked in the top/bottom band; continuous,
//     accelerating; used during a drag because DND grabs the wheel.
//   • scrollBy() — discrete notches from a wheel event on the flyout;
//     used only when no drag owns the pointer. Both drive _view through
//     the same layout() so the visual result is identical.
//
// Rows render at full opacity.

import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Scheduling from './scheduling.js';
import * as Theme from './theme.js';
import { S } from './sizes.js';
import { Smoother } from './smoother.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const VISIBLE_SLOTS = 8;
const RAIL_PAD = 16;
const DEAD = 0.06;

const TICK_W = 18;
const TICK_H = 5;

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

        this._upLabel = new St.Label({ style_class: 'ws-flyout-edge-label' });
        this._downLabel = new St.Label({ style_class: 'ws-flyout-edge-label' });
        upEl.add_child(this._upLabel);
        downEl.add_child(this._downLabel);

        this._items = [];
        this._rowEls = new Map();
        this._view = 0;
        this._highlight = -1;
        this._slots = 1;
        this._half = 0;
        this._maxSlots = null;
        this._hostH = 0;
        this._edgeDir = 0;
        this._edgeDepth = 0;
        this._raf = 0;
        this._last = 0;
        this._refitId = 0;
        this._zoneText = { up: '', down: '' };
        this._zoneAlpha = { up: -1, down: -1 };

        this._scope = new Scheduling.Scope();
        this._smooth = new Smoother(this._scope, {
            onFrame: v => {
                if (!this._alive()) { this._smooth.stop(); return; }
                this._view = v;
                const r = Math.round(v);
                if (r !== this._highlight) this._highlight = r;
                this.layout();
            },
        });
    }

    get count() { return this._items.length; }
    get highlighted() { return this._highlight; }
    get selectedIndex() { return Math.max(0, this._highlight); }
    scrolling() { return this._edgeDir !== 0 || this._smooth.running; }

    setViewport(height) { this._hostH = height; }
    setMaxSlots(n) { this._maxSlots = (n != null) ? Math.max(1, n) : null; }

    setItems(items, startIndex = 0) {
        this.stopEdge();
        this._items = items;
        this._slots = Math.min(VISIBLE_SLOTS, this._maxSlots ?? VISIBLE_SLOTS,
            Math.max(1, items.length));
        this._half = (this._slots - 1) / 2;
        this._rowsEl.set_height(this._slots * S.flyout.rowSlot);

        for (const [, el] of this._rowEls) el.destroy();
        this._rowEls.clear();

        this._view = this._clampV(Math.max(0, startIndex));
        this._highlight = Math.round(this._view);

        this._buildRail();
        this.layout();

        if (this._refitId) { GLib.Source.remove(this._refitId); this._refitId = 0; }
        this._refitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._refitId = 0;
            if (this._alive() && this._items.length) this._refitEdges();
            return GLib.SOURCE_REMOVE;
        });
    }

    _isStrip() { return this._items.length > this._slots; }
    _minV() { return this._isStrip() ? this._half : (this._items.length - 1) / 2; }
    _maxV() { return this._isStrip() ? this._items.length - 1 - this._half : (this._items.length - 1) / 2; }
    _clampV(v) { return clamp(v, this._minV(), this._maxV()); }

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
                x: Math.round((w - TICK_W) / 2),
                y: Math.round(this._railY(i)) - Math.round(TICK_H / 2),
                width: TICK_W, height: TICK_H,
            });
            tick.set_style(`background-color: ${it.color || Theme.C.muted};`);
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

    _fitEdgeLabel(label, band) {
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        label.clutter_text.set_line_wrap(false);
        label.clutter_text.set_line_alignment(Pango.Alignment.CENTER);

        const [, natW] = label.get_preferred_width(-1);
        const w = natW > 0 ? Math.ceil(natW) : Math.max(1, Math.ceil(band.width));
        const [, natH] = label.get_preferred_height(w);
        const h = natH > 0 ? Math.ceil(natH) : Math.round(band.height * 0.6);

        label.set_size(w, h);
        label.set_position(
            Math.max(0, Math.round((band.width - w) / 2)),
            Math.max(0, Math.round((band.height - h) / 2)));
    }

    _refitEdges() {
        if (this._upEl.visible) this._fitEdgeLabel(this._upLabel, this._upEl);
        if (this._downEl.visible) this._fitEdgeLabel(this._downLabel, this._downEl);
    }

    layout() {
        const R = this._items.length;
        const vis = this._slots;
        const lo = this._isStrip() ? Math.max(0, Math.floor(this._view - this._half - 1)) : 0;
        const hi = this._isStrip() ? Math.min(R - 1, Math.ceil(this._view + this._half + 1)) : R - 1;

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
            el.translation_y = Math.round((d + (vis - 1) / 2) * S.flyout.rowSlot);

            const sel = r === this._highlight;
            if (sel) el.add_style_class_name('sel');
            else el.remove_style_class_name('sel');

            el.opacity = 255;
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

    _updateEdges() {
        const now = this._view;
        const t = depthToT(this._edgeDepth);
        const above = this._isStrip() ? Math.max(0, Math.round(now - this._half)) : 0;
        const below = this._isStrip()
            ? Math.max(0, Math.round(this._items.length - 1 - this._half - now)) : 0;

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
                this._fitEdgeLabel(label, el);
            }
            const alpha = active ? Math.round(clamp(t * 0.42, 0, 1) * 100) / 100 : 0;
            if (this._zoneAlpha[which] !== alpha) {
                this._zoneAlpha[which] = alpha;
                el.set_style(`background-color: ${Theme.rgba('accent', alpha)};`);
            }
        };

        apply('up', this._upEl, this._upLabel, above, -1, '▲', 'above');
        apply('down', this._downEl, this._downLabel, below, 1, '▼', 'below');
    }

    setEdge(dir, depth) {
        this._smooth.stop();

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
        if (!this._edgeDir) { this._raf = 0; return GLib.SOURCE_REMOVE; }
        if (!this._alive()) {
            this._raf = 0;
            this._edgeDir = 0;
            this._edgeDepth = 0;
            this._updateEdges();
            this._updateMarker();
            return GLib.SOURCE_REMOVE;
        }

        const now = GLib.get_monotonic_time() / 1000;
        const dt = Math.min(now - this._last, 60) / 1000;
        this._last = now;

        this._view = this._clampV(this._view + this._edgeDir * edgeSpeed(this._edgeDepth) * dt);
        const r = Math.round(this._view);
        if (r !== this._highlight) this._highlight = r;
        this.layout();

        if (this._view <= this._minV() || this._view >= this._maxV()) {
            this._raf = 0;
            this._edgeDir = 0;
            this._edgeDepth = 0;
            this._updateEdges();
            this._updateMarker();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    scrollBy(delta) {
        if (!this._isStrip() || !delta) return;
        this.stopEdge();
        if (!this._smooth.running) this._smooth.value = this._view;
        const base = this._smooth.running ? this._smooth.target : this._view;
        this._smooth.to(this._clampV(base + delta));
    }

    over(y) {
        if (this._smooth.running) return this._highlight;

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

        const idx = Math.round((y - rowsTop) / S.flyout.rowSlot - (this._slots - 1) / 2 + this._view);
        if (idx < 0 || idx >= this._items.length) return -1;
        this.setHighlight(idx);
        return idx;
    }

    clearHover() { this.setHighlight(-1); }

    destroy() {
        if (this._refitId) { GLib.Source.remove(this._refitId); this._refitId = 0; }
        this._smooth.stop();
        this.stopEdge();
        for (const [, el] of this._rowEls) el.destroy();
        this._rowEls.clear();
        this._items = [];
        this._scope.dispose();
    }
}