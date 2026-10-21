// ===== FILE: ./lib/flyout.js =====
// The prototype's #fan.local-anchored: the same strip, detached from the
// HUD and parked next to a dock icon. Opened by a dwell during an internal
// window drag (delegate.handleDragOver) or by the external-drag poll
// (pointerAt) — both drive the same PagedStrip. Also openable without a
// drag ("sticky", e.g. from DBus; or "hover", from an icon hover).
//
// Drag-opened flyouts (onDrop set AND not sticky) get a CANCEL zone above
// the header: dropping there closes the flyout and leaves the window where
// it was. Sticky and hover flyouts do not get it.
//
// Scrolling:
//   • During a drag the DND grab owns the pointer; the wheel never reaches
//     this actor. Edge-hover (top/bottom bands) still works because it's a
//     pointer-position check inside PagedStrip.over().
//   • Outside a drag, wheel events arrive at captured-event and are routed
//     to PagedStrip.scrollBy() (one row per notch, SMOOTH accumulators
//     handled the same way as appOverlay's pinned row).
//
// Hover-activate: when the flyout was NOT opened by a drag, hovering a
// row for HOVER_ACTIVATE_MS brings that window to the foreground and
// maximizes it, without closing the flyout. Clicking a row activates
// and closes. During a drag, motion events are routed to the drag actor
// and this handler does not fire — the indicator's poll drives preview
// instead, via the same WorkspaceActions.focusWindow().
//
// Selected window: a hover flyout opened from a window icon is given
// `selectedWindow`; that window's row is highlighted (.ws-flyout-row.sel)
// and scrolled into view. highlightWindow() moves it when the pointer
// slides to a sibling icon while the flyout stays open.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Model from './model.js';
import * as Scheduling from './scheduling.js';
import * as Interactions from './interactions.js';
import * as UI from './ui.js';
import * as WorkspaceActions from './workspaceActions.js';
import { PagedStrip, ROW_SLOT, VISIBLE_SLOTS } from './strip.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const PAD = 20;
const RAIL_W = 48;
const GAP = 12;

const HEAD_H = 48;
const EDGE_H = 44;

// Drag-only cancel zone above the header.
const CANCEL_H = 56;
const CANCEL_GAP = 8;

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
        this._sticky = false;
        this._anchorKey = null;

        // Cancel zone state (local-y band inside _root; 0 height = absent)
        this._cancelY = 0;
        this._cancelH = 0;
        this._cancelActive = false;

        // Wheel accumulator (SMOOTH deltas are fractions of a notch)
        this._wheelAccum = 0;

        // Hover-activate state
        this._hoverActivate = false;
        this._hoveredIdx = -1;
        this._hoverActivateId = 0;

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

        const cancel = UI.createCancelZone('DROP HERE TO CANCEL');
        this._cancelEl = cancel.actor;
        this._cancelEl.visible = false;

        this._rowsEl = new St.Widget({ clip_to_allocation: true });
        this._upEl = new St.Widget({ style_class: 'ws-flyout-edge ws-flyout-edge-up' });
        this._downEl = new St.Widget({ style_class: 'ws-flyout-edge ws-flyout-edge-down' });
        this._rail = UI.createRail();

        this._root.add_child(this._cancelEl);
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
                const y = py - ry;

                if (this._inCancel(y)) {
                    this._strip.stopEdge();
                    this._strip.clearHover();
                    this._setCancelActive(true);
                    return Interactions.DragMotionResult.MOVE_DROP;
                }
                this._setCancelActive(false);
                this._strip.over(y);
                return Interactions.DragMotionResult.MOVE_DROP;
            },
            acceptDrop: source => {
                const [, py] = global.get_pointer();
                const [, ry] = this._root.get_transformed_position();
                if (this._inCancel(py - ry)) {
                    journal('[flyout] drop on cancel zone -> cancelled');
                    this.close(true);
                    return true;
                }
                const idx = this._strip.highlighted;
                const item = idx >= 0 ? this._items[idx] : null;
                const handled = this._onDrop ? this._onDrop(source, item) : false;
                this.close(true);
                return handled;
            },
        };

        this._scope.connect(this._root, 'captured-event', (a, event) => {
            if (!this._open) return Clutter.EVENT_PROPAGATE;
            const type = event.type();

            if (type === Clutter.EventType.SCROLL) {
                // No wheel scrolling over the cancel zone — that band is
                // reserved for "drop to cancel".
                if (this._cancelH > 0) {
                    const [, py] = global.get_pointer();
                    const [, ry] = this._root.get_transformed_position();
                    if (this._inCancel(py - ry)) return Clutter.EVENT_STOP;
                }

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

                if (step) {
                    // Wheel replaces hover: a pending preview for the row
                    // under the pointer should not fire while scrolling.
                    this._cancelHoverActivate();
                    this._hoveredIdx = -1;
                    this._strip.scrollBy(step);
                }
                return Clutter.EVENT_STOP;
            }

            if (type !== Clutter.EventType.MOTION) return Clutter.EVENT_PROPAGATE;
            const [, sy] = event.get_coords();
            const [, ry] = this._root.get_transformed_position();
            const idx = this._strip.over(sy - ry);
            if (this._hoverActivate) this._onHoverRow(idx);
            return Clutter.EVENT_PROPAGATE;
        });
        this._scope.connect(this._root, 'leave-event', () => {
            this._cancelHoverActivate();
            this._hoveredIdx = -1;
            this._setCancelActive(false);
            if (this._open) {
                this._strip.stopEdge();
                this._strip.clearHover();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    get isOpen() { return this._open; }
    get anchor() { return this._anchor; }
    get items() { return this._items; }
    get sticky() { return this._sticky; }
    get anchorKey() { return this._anchorKey; }

    // ---------- cancel zone ----------
    _inCancel(y) {
        return this._cancelH > 0 && y >= this._cancelY && y <= this._cancelY + this._cancelH;
    }

    _setCancelActive(on) {
        if (this._cancelActive === on) return;
        this._cancelActive = on;
        if (on) this._cancelEl.add_style_class_name('active');
        else this._cancelEl.remove_style_class_name('active');
    }

    // ---------- hover-activate ----------
    _onHoverRow(idx) {
        if (idx === this._hoveredIdx) return;
        this._hoveredIdx = idx;
        this._cancelHoverActivate();
        if (idx < 0) return;
        const item = this._items[idx];
        if (!item?.window) return;
        this._hoverActivateId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, this._settings.get_int('flyout-dwell-ms'), () => {
                this._hoverActivateId = 0;
                if (!this._open) return GLib.SOURCE_REMOVE;
                WorkspaceActions.focusWindow(item.window);
                journal(`[flyout] hover preview "${item.title}"`);
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelHoverActivate() {
        if (this._hoverActivateId) {
            GLib.Source.remove(this._hoverActivateId);
            this._hoverActivateId = 0;
        }
    }

    _startWatch() {
        if (this._watchId) return;
        journal('[flyout.watch] started');
        this._watchLogAt = 0;
        this._watchId = this._scope.timeout(120, () => {
            if (!this._open || this._sticky) {
                this._watchId = 0;
                journal('[flyout.watch] stopped');
                return GLib.SOURCE_REMOVE;
            }
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

        row.connect('button-press-event', (a, e) => {
            if (e.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            this._activateItem(item);
            return Clutter.EVENT_STOP;
        });
        return row;
    }

    _activateItem(item) {
        if (!item?.window) return;
        WorkspaceActions.focusWindow(item.window);
        journal(`[flyout] row activate "${item.title}"`);
        this.close(true);
    }

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
            return false;
        }
    }

    pointerAt(x, y) {
        if (!this.contains(x, y)) {
            this._setCancelActive(false);
            if (this._strip.highlighted >= 0) this._strip.clearHover();
            return null;
        }
        const [, ry] = this._root.get_transformed_position();
        if (this._inCancel(y - ry)) {
            this._setCancelActive(true);
            this._strip.stopEdge();
            this._strip.clearHover();
            return null;
        }
        this._setCancelActive(false);
        const idx = this._strip.over(y - ry);
        if (idx < 0) return null;
        return { index: idx, item: this._items[idx] ?? null };
    }

    /**
     * Point the watchdog at a new anchor without reopening. Used when
     * the pointer sweeps between sibling icons whose flyout content is
     * already correct, and after a re-render replaced the anchor actor.
     */
    retarget(anchor) {
        if (!this._open || !anchor) return;
        if (this._anchor === anchor) return;
        this._anchor = anchor;
        this._misses = 0;
    }

    // NEW
    /** Highlight (and scroll to) the row for `win`, e.g. when the pointer
     *  moves to a sibling icon while the flyout stays open. */
    highlightWindow(win) {
        if (!this._open || !win) return;
        const idx = this._items.findIndex(i => i.window === win);
        if (idx < 0) return;
        this._strip.setHighlight(idx);
        this._strip.center(idx);
    }

    open({
        anchor, title, items, onDrop,
        sticky = false, anchorKey = null, hoverActivate = false,
        selectedWindow = null,                       // NEW
    }) {
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
        this._hoverActivate = hoverActivate;
        this._hoveredIdx = -1;
        this._wheelAccum = 0;
        this._cancelHoverActivate();
        this._setCancelActive(false);

        const W = clamp(Math.round(monitor.width * 0.26), 560, 1080);
        const rowsW = W - PAD * 2 - RAIL_W - GAP;

        // The cancel zone only exists for drag-opened flyouts: onDrop is
        // set AND the flyout is not sticky (DBus/hover opens pass sticky
        // or no onDrop, so they never get it).
        const cancelH = (onDrop && !sticky) ? CANCEL_H : 0;
        const topExtra = cancelH ? cancelH + CANCEL_GAP : 0;

        const chromeH = PAD * 2 + topExtra + HEAD_H + EDGE_H * 2;
        const maxRowsH = Math.max(ROW_SLOT, monitor.height - 120 - chromeH);
        const slots = Math.max(1, Math.min(VISIBLE_SLOTS, items.length,
            Math.floor(maxRowsH / ROW_SLOT)));
        const rowsH = slots * ROW_SLOT;
        const H = chromeH + rowsH;

        const cancelY = PAD;
        const headY = PAD + topExtra;
        const upY = headY + HEAD_H;
        const rowsY = upY + EDGE_H;
        const downY = rowsY + rowsH;

        this._rowsW = rowsW;
        this._cancelY = cancelY;
        this._cancelH = cancelH;

        this._cancelEl.visible = cancelH > 0;
        if (cancelH > 0) {
            this._cancelEl.set_position(PAD, cancelY);
            this._cancelEl.set_size(W - PAD * 2, cancelH);
        }

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

        let ax, ay, aw, ah;
        try {
            [ax, ay] = anchor.get_transformed_position();
            [aw, ah] = anchor.get_transformed_size();
        } catch (e) {
            journal(`[flyout.open] anchor geometry threw: ${e.message}`);
            return false;
        }
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

        try {
            Main.layoutManager.uiGroup.set_child_above_sibling(this._root, null);
        } catch (e) {
            journal(`[flyout.open] set_child_above_sibling failed: ${e.message}`);
        }

        journal(`[flyout.open] W=${W} H=${H} slots=${slots} ` +
            `left=${Math.round(left)} top=${Math.round(top)} opensDown=${this._opensDown} ` +
            `hoverActivate=${hoverActivate} sticky=${sticky} cancelZone=${cancelH > 0}`);

        const px = clamp((ax + aw / 2 - left) / W, 0.08, 0.92);
        this._root.set_pivot_point(px, this._opensDown ? 0 : 1);

        // ---- strip setup (CHANGED) ----
        this._strip.setMaxSlots(slots);
        this._strip.setViewport(H);

        // Row of the window whose icon opened the flyout, if any.
        const selIdx = selectedWindow
            ? items.findIndex(i => i.window === selectedWindow)
            : -1;

        // Start scrolled so that row is in view, then highlight it
        // (this applies the .ws-flyout-row.sel style).
        this._strip.setItems(items, Math.max(0, selIdx));
        this._strip.clearHover();
        if (selIdx >= 0) this._strip.setHighlight(selIdx);
        // ---- end of change ----

        this._open = true;
        this._sticky = sticky;
        this._anchorKey = anchorKey;
        this._misses = 0;

        this._root.remove_all_transitions();
        this._root.show();
        this._root.opacity = 255;

        const openDur = Model.animationDuration(190);
        if (openDur === 0) {
            this._root.translation_y = 0;
            this._root.set_scale(1, 1);
        } else {
            this._root.translation_y = this._opensDown ? -12 : 12;
            this._root.set_scale(0.96, 0.96);
            this._root.ease({
                translation_y: 0,
                scale_x: 1, scale_y: 1,
                duration: openDur,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }

        if (sticky) {
            journal('[flyout.open] sticky — watchdog off, rows are click-to-activate');
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
        this._cancelHoverActivate();
        this._hoveredIdx = -1;
        this._wheelAccum = 0;
        this._setCancelActive(false);
        this._cancelH = 0;
        this._strip.stopEdge();
        this._strip.clearHover();
        this._onDrop = null;
        this._root.remove_all_transitions();

        if (instant) {
            this._root.hide();
            this._anchor = null;
            return;
        }

        const closeDur = Model.animationDuration(130);
        if (closeDur === 0) {
            this._root.hide();
            this._anchor = null;
            return;
        }

        this._root.ease({
            opacity: 0,
            translation_y: this._opensDown ? -12 : 12,
            scale_x: 0.97, scale_y: 0.97,
            duration: closeDur,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => { if (!this._open) this._root.hide(); },
        });
        this._anchor = null;
    }

    destroy() {
        this._open = false;
        this._sticky = false;
        this._anchorKey = null;
        this._cancelHoverActivate();
        if (this._watchId) { this._scope.cancel(this._watchId); this._watchId = 0; }
        this._strip?.destroy();
        this._scope.dispose();
        try { Main.layoutManager.removeChrome(this._root); } catch (e) { /* already gone */ }
        this._root.destroy();
        this._root = null;
    }
}