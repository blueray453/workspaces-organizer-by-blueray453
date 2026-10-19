// ===== FILE: ./lib/flyout.js =====
// The prototype's #fan.local-anchored: the same strip, detached from the
// HUD and parked next to a dock icon. Opened by a dwell during an internal
// window drag (delegate.handleDragOver) or by the external-drag poll
// (pointerAt) — both drive the same PagedStrip. Also openable without a
// drag ("sticky", e.g. from DBus): rows are then click-to-activate and the
// pointer watchdog is off.
//
// Vertical layout is stacked fixed-height bands — padding, header,
// up-edge, rows, down-edge, padding — so the edge labels ("N more
// above/below") own dedicated space and can never run under the header or
// get clipped. The edge bands are plain fixed-layout widgets: the strip
// positions their labels by hand at natural size, so the full sentence is
// always visible.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Scheduling from './scheduling.js';
import * as Interactions from './interactions.js';
import * as UI from './ui.js';
import { PagedStrip, ROW_SLOT, VISIBLE_SLOTS } from './strip.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Panel metrics scaled ~2x versus the original 12/28/8 layout.
const PAD = 20;
const RAIL_W = 48;
const GAP = 12;

// Band heights sized for their fonts with headroom: the 32px header needs
// more than its glyph height, and the 22px edge labels need their own
// bands so they never share space with the header.
const HEAD_H = 48;
const EDGE_H = 44;

// Large, legible row text: 38px titles over 72px icons in 112px slots.
const ROW_ICON_SIZE = 72;
const ROW_LABEL_SIZE = 38;

export class GroupFlyout {
    constructor(settings) {
        this._settings = settings;
        this._scope = new Scheduling.Scope();
        this._open = false;
        this._items = [];
        this._anchor = null;
        this._onDrop = null;
        this._misses = 0;
        this._opensDown = true;
        this._rowsW = 240;
        this._watchId = 0;
        this._watchLogAt = 0;
        this._sticky = false;      // DBus-opened flyout (no drag lifetime)
        this._anchorKey = null;    // identity used by ToggleGroupFlyout

        this._root = new St.Widget({
            style_class: 'ws-flyout',
            reactive: true, track_hover: true, clip_to_allocation: true,
        });
        this._root.opacity = 0;
        this._root.visible = false;

        this._head = new St.Label({ style_class: 'ws-flyout-head', text: '' });
        this._head.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._head.clutter_text.set_line_wrap(false);
        this._head.set_style('font-size: 32px;');

        this._rowsEl = new St.Widget({ clip_to_allocation: true });
        // Plain fixed-layout widgets: the strip positions their child
        // labels by hand, so container alignment can never shrink them.
        this._upEl = new St.Widget({ style_class: 'ws-flyout-edge ws-flyout-edge-up' });
        this._downEl = new St.Widget({ style_class: 'ws-flyout-edge ws-flyout-edge-down' });
        this._rail = UI.createRail();

        this._root.add_child(this._head);
        this._root.add_child(this._upEl);
        this._root.add_child(this._downEl);
        this._root.add_child(this._rail.root);
        this._root.add_child(this._rowsEl);

        Main.layoutManager.addChrome(this._root);

        this._strip = new PagedStrip({
            rowsEl: this._rowsEl,
            upEl: this._upEl,
            downEl: this._downEl,
            rail: this._rail,
            makeRow: item => this._makeRow(item),
            onEdgeStart: () => { this._misses = 0; },
            alive: () => this._open,
        });

        this._root._delegate = {
            handleDragOver: () => {
                this._misses = 0;
                const [, py] = global.get_pointer();
                const [, ry] = this._root.get_transformed_position();
                this._strip.over(py - ry);
                return Interactions.DragMotionResult.MOVE_DROP;
            },
            acceptDrop: source => {
                const idx = this._strip.highlighted;
                const item = idx >= 0 ? this._items[idx] : null;
                const handled = this._onDrop ? this._onDrop(source, item) : false;
                this.close(true);
                return handled;
            },
        };

        // Hover highlight + edge auto-scroll when no drag owns the pointer
        // (DBus-opened flyout). During a drag the grab routes motion to the
        // drag actor and the external poll drives `over()` instead.
        this._scope.connect(this._root, 'captured-event', (a, event) => {
            if (!this._open || event.type() !== Clutter.EventType.MOTION)
                return Clutter.EVENT_PROPAGATE;
            const [, sy] = event.get_coords();
            const [, ry] = this._root.get_transformed_position();
            this._strip.over(sy - ry);
            return Clutter.EVENT_PROPAGATE;
        });
        this._scope.connect(this._root, 'leave-event', () => {
            if (this._open) this._strip.clearHover();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    get isOpen() { return this._open; }
    get anchor() { return this._anchor; }
    get items() { return this._items; }
    get sticky() { return this._sticky; }
    get anchorKey() { return this._anchorKey; }

    /**
     * Dismissal watchdog. Also emits a throttled state line so the caller
     * can see whether the flyout is actually visible (opacity, scale,
     * mapped) while the drag is in flight.
     */
    _startWatch() {
        if (this._watchId) return;
        journal('[flyout.watch] started');
        this._watchLogAt = 0;
        this._watchId = this._scope.timeout(120, () => {
            if (!this._open) { this._watchId = 0; journal('[flyout.watch] stopped'); return GLib.SOURCE_REMOVE; }
            const [x, y] = global.get_pointer();
            const over = this._isOver(x, y);

            const nowMs = GLib.get_monotonic_time() / 1000;
            if (nowMs - (this._watchLogAt ?? 0) > 500) {
                this._watchLogAt = nowMs;
                let rx = NaN, ry = NaN, rw = NaN, rh = NaN;
                try {
                    [rx, ry] = this._root.get_transformed_position();
                    [rw, rh] = this._root.get_transformed_size();
                } catch (e) { /* actor may be mid-destroy */ }
                journal(`[flyout.watch] ptr=${x},${y} over=${over} ` +
                    `bounds=${Math.round(rx)},${Math.round(ry)} ${Math.round(rw)}x${Math.round(rh)} ` +
                    `opacity=${this._root.opacity} visible=${this._root.visible} ` +
                    `mapped=${this._root.is_mapped()} scale=${this._root.get_scale().join(',')}`);
            }

            if (over) this._misses = 0;
            else if (++this._misses >= 2) {
                journal(`[flyout.watch] pointer left (${x},${y}) -> close`);
                this.close();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _makeRow(item) {
        const row = UI.createFlyoutRow({
            gicon: item.icon,
            title: item.title,
            sub: item.sub || '',
            badge: item.badge || '',
            width: this._rowsW,
            height: ROW_SLOT,
            iconSize: ROW_ICON_SIZE,
            labelSize: ROW_LABEL_SIZE,
        });

        // Click-to-activate: harmless during a drag (button is held, no
        // click events are delivered) and the primary interaction for
        // DBus-opened flyouts, where there is no drag payload to drop.
        row.connect('button-press-event', (a, e) => {
            if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            this._activateItem(item);
            return Clutter.EVENT_STOP;
        });
        return row;
    }

    _activateItem(item) {
        if (!item?.window) return;
        try {
            const win = item.window;
            if (win.minimized) win.unminimize();
            const ws = win.get_workspace();
            if (ws) ws.activate_with_focus(win, global.get_current_time());
            else win.activate(global.get_current_time());
            journal(`[flyout] row activate "${item.title}"`);
        } catch (e) {
            journal(`[flyout] row activate failed: ${e.message}`);
        }
        this.close(true);
    }

    /** Inside the flyout OR back over the icon that opened it. */
    _isOver(x, y) {
        return this.contains(x, y) || this.isOverAnchor(x, y);
    }

    contains(x, y) {
        if (!this._open || !this._root.get_stage()) return false;
        const [rx, ry] = this._root.get_transformed_position();
        const [rw, rh] = this._root.get_transformed_size();
        return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
    }

    isOverAnchor(x, y) {
        const a = this._anchor;
        if (!this._open || !a) return false;
        try {
            if (!a.get_stage()) return false;
            const [ax, ay] = a.get_transformed_position();
            const [aw, ah] = a.get_transformed_size();
            return x >= ax && x <= ax + aw && y >= ay && y <= ay + ah;
        } catch (e) {
            return false;   // anchor destroyed mid-drag by a re-render
        }
    }

    pointerAt(x, y) {
        if (!this.contains(x, y)) {
            if (this._strip.highlighted >= 0) this._strip.clearHover();
            return null;
        }
        const [, ry] = this._root.get_transformed_position();
        const idx = this._strip.over(y - ry);
        if (idx < 0) return null;
        return { index: idx, item: this._items[idx] ?? null };
    }

    open({ anchor, title, items, onDrop, sticky = false, anchorKey = null }) {
        let onStage = false;
        try { onStage = !!anchor?.get_stage(); } catch (e) { onStage = false; }
        if (!anchor || !onStage || !items?.length) {
            journal(`[flyout.open] rejected anchor=${!!anchor} onStage=${onStage} items=${items?.length}`);
            return false;
        }

        if (this._open && this._anchor === anchor) { this._misses = 0; return true; }

        const monitorIndex = Math.max(0, Main.layoutManager.findIndexForActor(anchor));
        const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;

        this._anchor = anchor;
        this._items = items;
        this._onDrop = onDrop;

        const W = clamp(Math.round(monitor.width * 0.26), 560, 1080);
        const rowsW = W - PAD * 2 - RAIL_W - GAP;

        // ---------- stacked band layout ----------
        // padding | header | up-edge | rows | down-edge | padding. Each
        // band owns fixed vertical space, so "N more above" can never sit
        // under the header and no label is clipped. The slot count adapts
        // to the monitor instead of clamping H and squeezing the bands.
        const chromeH = PAD * 2 + HEAD_H + EDGE_H * 2;
        const maxRowsH = Math.max(ROW_SLOT, monitor.height - 120 - chromeH);
        const slots = Math.max(1, Math.min(VISIBLE_SLOTS, items.length,
            Math.floor(maxRowsH / ROW_SLOT)));
        const rowsH = slots * ROW_SLOT;
        const H = chromeH + rowsH;

        const headY = PAD;
        const upY = headY + HEAD_H;
        const rowsY = upY + EDGE_H;
        const downY = rowsY + rowsH;

        this._rowsW = rowsW;

        this._head.set_position(PAD, headY);
        this._head.set_size(W - PAD * 2, HEAD_H);
        this._head.set_text(title || '');

        this._rowsEl.set_position(PAD, rowsY);
        this._rowsEl.set_size(rowsW, rowsH);

        this._rail.root.set_position(W - PAD - RAIL_W, rowsY);
        this._rail.root.set_size(RAIL_W, rowsH);

        this._upEl.set_position(0, upY);
        this._upEl.set_size(W, EDGE_H);
        this._downEl.set_position(0, downY);
        this._downEl.set_size(W, EDGE_H);

        this._root.set_size(W, H);

        // ---------- anchor geometry ----------
        let ax, ay, aw, ah;
        try {
            [ax, ay] = anchor.get_transformed_position();
            [aw, ah] = anchor.get_transformed_size();
        } catch (e) {
            journal(`[flyout.open] anchor geometry threw: ${e.message}`);
            return false;
        }
        // A just-rebuilt anchor has no allocation yet and reports NaN;
        // placing the flyout at NaN makes it invisible and makes the
        // watchdog close it instantly. Refuse; the caller retries after
        // allocation.
        if (![ax, ay, aw, ah].every(Number.isFinite) || aw <= 0 || ah <= 0) {
            journal(`[flyout.open] anchor not allocated yet: ax=${ax} ay=${ay} aw=${aw} ah=${ah}`);
            return false;
        }

        const left = clamp(ax + aw / 2 - W / 2, monitor.x + 8, monitor.x + monitor.width - W - 8);
        let top = ay - H - 16;
        this._opensDown = false;
        if (top < monitor.y + 8) {
            top = Math.max(monitor.y + 8, ay + ah + 16);
            this._opensDown = true;
        }
        if (top + H > monitor.y + monitor.height - 8)
            top = Math.max(monitor.y + 8, monitor.y + monitor.height - H - 8);

        this._root.set_position(Math.round(left), Math.round(top));

        // Float above client windows so a maximized preview cannot hide it.
        try {
            Main.layoutManager.uiGroup.set_child_above_sibling(this._root, null);
            const children = Main.layoutManager.uiGroup.get_children();
            journal(`[flyout.open] uiGroup: idx=${children.indexOf(this._root)} total=${children.length}`);
        } catch (e) {
            journal(`[flyout.open] set_child_above_sibling failed: ${e.message}`);
        }

        journal(`[flyout.open] monitor=${monitor.x},${monitor.y} ${monitor.width}x${monitor.height} ` +
            `W=${W} H=${H} slots=${slots} rowsY=${rowsY} upY=${upY} downY=${downY} ` +
            `left=${Math.round(left)} top=${Math.round(top)} opensDown=${this._opensDown} ` +
            `anchor=${Math.round(ax)},${Math.round(ay)} ${Math.round(aw)}x${Math.round(ah)}`);

        const px = clamp((ax + aw / 2 - left) / W, 0.08, 0.92);
        this._root.set_pivot_point(px, this._opensDown ? 0 : 1);

        this._strip.setMaxSlots(slots);
        this._strip.setViewport(H);
        this._strip.setItems(items, 0);
        this._strip.clearHover();

        this._open = true;
        this._sticky = sticky;
        this._anchorKey = anchorKey;
        this._misses = 0;

        // ---------- show ----------
        //
        // Two independent changes:
        //
        //   1. Opacity is set to 255 immediately. The previous version eased
        //      it from 0 alongside translation_y, and translation_y is not
        //      an animatable Clutter ease target on all GNOME versions —
        //      which can make the whole transition fail silently and leave
        //      opacity pinned at 0. The flyout is then "open" and pickable
        //      but invisible.
        //
        //   2. Only scale and translation are animated, both of which are
        //      universally supported by Clutter.ease().
        //
        this._root.remove_all_transitions();
        this._root.show();
        this._root.opacity = 255;
        this._root.translation_y = this._opensDown ? -12 : 12;
        this._root.set_scale(0.96, 0.96);

        journal(`[flyout.open] shown: opacity=${this._root.opacity} visible=${this._root.visible} ` +
            `mapped=${this._root.is_mapped()} x=${this._root.x} y=${this._root.y} ` +
            `w=${this._root.width} h=${this._root.height} scale=${this._root.get_scale().join(',')}`);

        this._root.ease({
            translation_y: 0,
            scale_x: 1, scale_y: 1,
            duration: 190,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                journal(`[flyout.open] ease complete: opacity=${this._root.opacity} ` +
                    `scale=${this._root.get_scale().join(',')} ` +
                    `pos=${this._root.x},${this._root.y} size=${this._root.width}x${this._root.height}`);
            },
        });

        // Safety net: if for any reason the ease did not bring opacity to
        // full within 300ms, force it. This is a no-op when the ease works.
        this._scope.timeout(300, () => {
            if (this._open && this._root && this._root.opacity < 255) {
                journal(`[flyout.open] SAFETY FORCE opacity 255 (was ${this._root.opacity})`);
                this._root.opacity = 255;
            }
            return GLib.SOURCE_REMOVE;
        });

        if (sticky) {
            journal('[flyout.open] sticky (no drag) — watchdog off, rows are click-to-activate');
        } else {
            this._startWatch();
        }

        return true;
    }

    close(instant = false) {
        if (!this._open) return;
        journal(`[flyout.close] instant=${instant} sticky=${this._sticky}`);
        this._open = false;
        this._sticky = false;
        this._anchorKey = null;
        this._strip.stopEdge();
        this._strip.clearHover();
        this._onDrop = null;
        this._root.remove_all_transitions();

        if (instant) {
            this._root.hide();
            this._anchor = null;
            return;
        }

        this._root.ease({
            opacity: 0,
            translation_y: this._opensDown ? -12 : 12,
            scale_x: 0.97, scale_y: 0.97,
            duration: 130,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => { if (!this._open) this._root.hide(); },
        });
        this._anchor = null;
    }

    destroy() {
        this._open = false;
        this._sticky = false;
        this._anchorKey = null;
        if (this._watchId) { this._scope.cancel(this._watchId); this._watchId = 0; }
        this._strip?.destroy();
        this._scope.dispose();
        try { Main.layoutManager.removeChrome(this._root); } catch (e) { /* already gone */ }
        this._root.destroy();
        this._root = null;
    }
}