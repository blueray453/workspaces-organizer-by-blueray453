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
import * as Motion from './motion.js';
import { S } from './sizes.js';
import { Dwell, Poller, Misses } from './util.js';
import { PagedStrip, VISIBLE_SLOTS } from './strip.js';
import { externalDrag } from './externalDrag.js';
import { getPeek } from './peekController.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const HOVER_VELOCITY_WINDOW_MS = 120;
const HOVER_VELOCITY_MAX = 0.25;
const HOVER_POLL_MS = 30;

export class GroupFlyout {
    constructor(settings) {
        this._settings = settings;
        this._scope = new Scheduling.Scope();
        this._open = false;
        this._items = [];
        this._anchor = null;
        this._onDrop = null;
        this._opensDown = true;
        this._rowsW = 240;
        this._watchLogAt = 0;
        this._sticky = false;
        this._anchorKey = null;
        this._side = null;

        this._misses = new Misses(2, () => { this.close(); });
        this._hoverDwell = new Dwell(this._scope,
            () => this._settings.get_int('flyout-dwell-ms'));
        this._watch = new Poller(this._scope, {
            interval: 120, name: 'flyout.watch', tick: () => this._watchTick(),
        });

        this._motionSamples = [];
        this._hoverPoll = new Poller(this._scope, {
            interval: HOVER_POLL_MS, name: 'flyout.hover', tick: () => this._hoverTick(),
        });

        this._wheelAccum = 0;
        this._hoverActivate = false;

        this._root = new St.Widget({
            style_class: 'ws-flyout',
            reactive: true, track_hover: true, clip_to_allocation: true,
        });
        this._root.opacity = 0;
        this._root.visible = false;

        this._head = new St.Label({ style_class: 'ws-flyout-head', text: '' });
        this._head.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._head.clutter_text.set_line_wrap(false);

        this._rowsEl = new St.Widget({ clip_to_allocation: true });
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
            onEdgeStart: () => { this._misses.reset(); },
            alive: () => this._open,
        });

        this._root._delegate = {
            handleDragOver: () => {
                this._misses.reset();
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

        this._scope.connect(this._root, 'captured-event', (a, event) => {
            if (!this._open) return Clutter.EVENT_PROPAGATE;
            const type = event.type();

            if (type === Clutter.EventType.SCROLL) {
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
                    this._hoverDwell.cancel();
                    this._strip.scrollBy(step);
                }
                return Clutter.EVENT_STOP;
            }

            if (type !== Clutter.EventType.MOTION) return Clutter.EVENT_PROPAGATE;
            const [, sy] = event.get_coords();
            const [, ry] = this._root.get_transformed_position();
            this._strip.over(sy - ry);
            return Clutter.EVENT_PROPAGATE;
        });

        this._scope.connect(this._root, 'leave-event', () => {
            this._hoverDwell.cancel();
            if (this._open) {
                this._strip.stopEdge();
                this._strip.clearHover();
            }
            // During an external drag, leaving the flyout = intent to drop.
            // Promote the current clone to the real window.
            if (externalDrag.active) {
                getPeek().promoteToReal();
            } else {
                getPeek().stop();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    get isOpen() { return this._open; }
    get anchor() { return this._anchor; }
    get items() { return this._items; }
    get sticky() { return this._sticky; }
    get anchorKey() { return this._anchorKey; }

    _onHoverRow(idx) {
        const item = idx >= 0 ? this._items[idx] : null;
        if (!item?.window) {
            this._hoverDwell.cancel();
            return;
        }
        this._hoverDwell.arm(idx, () => {
            if (!this._open) return;
            getPeek().start(item.window, {
                mode: 'clone',
                below: this._root,
            });
            journal(`[flyout] hover peek "${item.title}"`);
        });
    }

    _cancelHoverActivate() { this._hoverDwell.cancel(); }

    _hoverTick() {
        if (!this._open || !this._hoverActivate) return false;

        const [px, py] = global.get_pointer();
        if (!this.contains(px, py)) {
            this._hoverDwell.cancel();
            this._motionSamples.length = 0;
            return true;
        }
        this._pushSample(px, py);
        if (this._pointerMoving()) {
            this._hoverDwell.cancel();
            return true;
        }
        const [, ry] = this._root.get_transformed_position();
        this._onHoverRow(this._strip.over(py - ry));
        return true;
    }

    _pushSample(x, y) {
        const now = GLib.get_monotonic_time() / 1000;
        const s = this._motionSamples;
        s.push({ t: now, x, y });
        while (s.length > 1 && now - s[0].t > HOVER_VELOCITY_WINDOW_MS) s.shift();
    }

    _pointerMoving() {
        const s = this._motionSamples;
        if (s.length < 2) return true;
        const first = s[0], last = s[s.length - 1];
        const dt = last.t - first.t;
        if (dt <= 0) return true;
        return Math.hypot(last.x - first.x, last.y - first.y) / dt > HOVER_VELOCITY_MAX;
    }

    _startWatch() {
        if (this._watch.running) return;
        this._watchLogAt = 0;
        this._watch.start();
    }

    _watchTick() {
        if (!this._open || this._sticky) return false;
        const [x, y] = global.get_pointer();
        const over = this._isOver(x, y);
        if (over) this._misses.reset();
        else this._misses.miss();
        return true;
    }

    _makeRow(item) {
        const row = UI.createFlyoutRow({
            gicon: item.icon,
            title: item.title,
            sub: item.sub || '',
            badge: item.badge || '',
            width: this._rowsW,
            height: S.flyout.rowSlot,
            iconSize: S.flyout.rowIcon,
            labelSize: S.flyout.rowLabel,
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
        WorkspaceActions.navigateToWindow(item.window);
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
        } catch (e) { return false; }
    }

    pointerAt(x, y) {
        if (!this.contains(x, y)) {
            this._strip.stopEdge();
            if (this._strip.highlighted >= 0) this._strip.clearHover();
            return null;
        }
        const [, ry] = this._root.get_transformed_position();
        const idx = this._strip.over(y - ry);
        if (idx < 0) return null;
        return { index: idx, item: this._items[idx] ?? null };
    }

    retarget(anchor) {
        if (!this._open || !anchor) return;
        if (this._anchor === anchor) return;
        this._anchor = anchor;
        this._misses.reset();
    }

    get actor() { return this._root; }

    highlightIndex(idx) {
        if (!this._open) return;
        this._strip.stopEdge();
        this._strip.setHighlight(idx);
    }

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
        selectedWindow = null,
        side = null, sideGap = 8, width = null,
    }) {
        let onStage = false;
        try { onStage = !!anchor?.get_stage(); } catch (e) { onStage = false; }
        if (!anchor || !onStage || !items?.length) {
            journal(`[flyout.open] rejected anchor=${!!anchor} onStage=${onStage} items=${items?.length}`);
            return false;
        }

        if (this._open && this._anchor === anchor) { this._misses.reset(); return true; }

        this._hoverPoll.stop();
        this._motionSamples.length = 0;

        const monitorIndex = Math.max(0, Main.layoutManager.findIndexForActor(anchor));
        const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;

        this._anchor = anchor;
        this._items = items;
        this._onDrop = onDrop;
        this._hoverActivate = hoverActivate;
        this._wheelAccum = 0;
        this._hoverDwell.cancel();

        const F = S.flyout;
        const PAD = F.pad, RAIL_W = F.railW, GAP = F.gap, HEAD_H = F.headH, EDGE_H = F.edgeH;

        const W = width ?? clamp(Math.round(monitor.width * 0.26), 720, 1440);
        const rowsW = W - PAD * 2 - RAIL_W - GAP;

        const chromeH = PAD * 2 + HEAD_H + EDGE_H * 2;
        const maxRowsH = Math.max(F.rowSlot, monitor.height - 120 - chromeH);
        const slots = Math.max(1, Math.min(VISIBLE_SLOTS, items.length,
            Math.floor(maxRowsH / F.rowSlot)));
        const rowsH = slots * F.rowSlot;
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

        let ax, ay, aw, ah;
        try {
            [ax, ay] = anchor.get_transformed_position();
            [aw, ah] = anchor.get_transformed_size();
        } catch (e) {
            journal(`[flyout.open] anchor geometry threw: ${e.message}`);
            return false;
        }
        if (![ax, ay, aw, ah].every(Number.isFinite) || aw <= 0 || ah <= 0) {
            journal(`[flyout.open] anchor not allocated: ${ax},${ay} ${aw}x${ah}`);
            return false;
        }

        this._side = side;
        let left, top;
        if (side === 'left') {
            this._opensDown = false;
            left = Math.max(monitor.x + 8, ax - W - sideGap);
            top = clamp(ay + ah / 2 - H / 2, monitor.y + 8,
                Math.max(monitor.y + 8, monitor.y + monitor.height - H - 8));
        } else {
            left = clamp(ax + aw / 2 - W / 2, monitor.x + 8, monitor.x + monitor.width - W - 8);
            top = ay - H - 16;
            this._opensDown = false;
            if (top < monitor.y + 8) {
                top = Math.max(monitor.y + 8, ay + ah + 16);
                this._opensDown = true;
            }
            if (top + H > monitor.y + monitor.height - 8)
                top = Math.max(monitor.y + 8, monitor.y + monitor.height - H - 8);
        }

        this._root.set_position(Math.round(left), Math.round(top));

        try { Main.layoutManager.uiGroup.set_child_above_sibling(this._root, null); }
        catch (e) { journal(`[flyout.open] restack failed: ${e.message}`); }

        if (side) {
            this._root.set_pivot_point(1, 0.5);
        } else {
            const px = clamp((ax + aw / 2 - left) / W, 0.08, 0.92);
            this._root.set_pivot_point(px, this._opensDown ? 0 : 1);
        }

        this._strip.setMaxSlots(slots);
        this._strip.setViewport(H);

        const selIdx = selectedWindow
            ? items.findIndex(i => i.window === selectedWindow)
            : -1;

        this._strip.setItems(items, Math.max(0, selIdx));
        this._strip.clearHover();
        if (selIdx >= 0) this._strip.setHighlight(selIdx);

        this._open = true;
        this._sticky = sticky;
        this._anchorKey = anchorKey;
        this._misses.reset();

        if (hoverActivate) this._hoverPoll.start();

        this._root.remove_all_transitions();
        Motion.enter(this._root, {
            dx: side ? 16 : 0,
            dy: side ? 0 : (this._opensDown ? -12 : 12),
        });

        if (!sticky) this._startWatch();
        return true;
    }

    close(instant = false) {
        if (!this._open) return;
        journal(`[flyout.close] instant=${instant} sticky=${this._sticky}`);
        this._open = false;
        this._sticky = false;
        this._anchorKey = null;
        this._hoverDwell.cancel();
        this._hoverPoll.stop();
        this._motionSamples.length = 0;
        this._wheelAccum = 0;
        this._strip.stopEdge();
        this._strip.clearHover();
        this._onDrop = null;
        this._root.remove_all_transitions();

        // Any pending peek is finished by caller — but safest to stop it.
        getPeek().stop();

        if (instant || Motion.dur('slideOut') === 0) {
            this._root.hide();
            this._anchor = null;
            this._side = null;
            return;
        }

        Motion.exit(this._root, {
            dx: this._side ? 16 : 0,
            dy: this._side ? 0 : (this._opensDown ? -12 : 12),
            onComplete: () => { if (!this._open) this._root.hide(); },
        });
        this._anchor = null;
        this._side = null;
    }

    destroy() {
        this._open = false;
        this._sticky = false;
        this._anchorKey = null;
        this._side = null;
        this._hoverDwell.cancel();
        this._hoverPoll.stop();
        this._motionSamples.length = 0;
        this._watch.stop();
        this._strip?.destroy();
        this._scope.dispose();
        try { Main.layoutManager.removeChrome(this._root); } catch (e) { /* gone */ }
        this._root.destroy();
        this._root = null;
    }
}