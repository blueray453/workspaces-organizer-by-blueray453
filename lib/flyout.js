// The prototype's #fan.local-anchored: the same strip, detached from the
// HUD and parked next to a dock icon. Here it is a chrome actor opened by
// a dwell while a window is being dragged over a grouped app icon.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Scheduling from './scheduling.js';
import * as Interactions from './interactions.js';
import * as UI from './ui.js';
import { PagedStrip, ROW_SLOT, VISIBLE_SLOTS } from './strip.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

const PAD = 12;
const RAIL_W = 28;
const GAP = 8;
const HEAD_H = 34;

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
        this._upEl = new St.Bin({ style_class: 'ws-flyout-edge ws-flyout-edge-up' });
        this._downEl = new St.Bin({ style_class: 'ws-flyout-edge ws-flyout-edge-down' });
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
                const item = this._items[this._strip.selectedIndex] ?? null;
                const handled = this._onDrop ? this._onDrop(source, item) : false;
                this.close(true);
                return handled;
            },
        };

        this._watchId = this._scope.timeout(120, () => {
            if (!this._open) { this._watchId = 0; return GLib.SOURCE_REMOVE; }
            const [x, y] = global.get_pointer();
            if (this._isOver(x, y)) this._misses = 0;
            else if (++this._misses >= 2) this.close();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get isOpen() { return this._open; }
    get anchor() { return this._anchor; }
    get items() { return this._items; }

    _makeRow(item) {
        const iconSize = Math.round(30 * (St.ThemeContext.get_for_stage(global.stage).scale_factor || 1));
        return UI.createFlyoutRow({
            gicon: item.icon,
            title: item.title,
            sub: item.sub || '',
            badge: item.badge || '',
            width: this._rowsW,
            height: ROW_SLOT,
            iconSize,
            labelSize: 14,
        });
    }

    _isOver(x, y) {
        const inside = (actor) => {
            if (!actor || !actor.get_stage() || !actor.visible) return false;
            const [ax, ay] = actor.get_transformed_position();
            const [aw, ah] = actor.get_transformed_size();
            return x >= ax && x <= ax + aw && y >= ay && y <= ay + ah;
        };
        return inside(this._root) || inside(this._anchor);
    }

    open({ anchor, title, items, onDrop }) {
        if (!anchor || !anchor.get_stage() || !items?.length) return;

        // Same group, already up: just keep it alive.
        if (this._open && this._anchor === anchor) { this._misses = 0; return; }

        const monitorIndex = Math.max(0, Main.layoutManager.findIndexForActor(anchor));
        const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;

        this._anchor = anchor;
        this._items = items;
        this._onDrop = onDrop;

        const W = clamp(Math.round(monitor.width * 0.18), 260, 380);
        const H = Math.min(440, Math.max(220, monitor.height - 96));
        const rowsW = W - PAD * 2 - RAIL_W - GAP;
        const rowsH = Math.min(VISIBLE_SLOTS, items.length) * ROW_SLOT;
        const rowsY = Math.round((H - rowsH) / 2);
        const railH = Math.min(rowsH, 300);

        this._rowsW = rowsW;

        this._head.set_position(PAD, 12);
        this._head.set_size(W - PAD * 2, 20);
        this._head.set_text(title || '');

        this._rowsEl.set_position(PAD, rowsY);
        this._rowsEl.set_size(rowsW, rowsH);

        this._rail.root.set_position(W - PAD - RAIL_W, Math.round((H - railH) / 2));
        this._rail.root.set_size(RAIL_W, railH);

        this._upEl.set_position(0, 0);
        this._upEl.set_size(W, Math.max(0, rowsY));
        this._downEl.set_position(0, rowsY + rowsH);
        this._downEl.set_size(W, Math.max(0, H - rowsY - rowsH));

        this._root.set_size(W, H);

        // ---------- anchor geometry ----------
        const [ax, ay] = anchor.get_transformed_position();
        const [aw, ah] = anchor.get_transformed_size();

        let left = clamp(ax + aw / 2 - W / 2, monitor.x + 8, monitor.x + monitor.width - W - 8);
        let top = ay - H - 10;
        this._opensDown = false;
        if (top < monitor.y + 8) {
            top = Math.max(monitor.y + 8, ay + ah + 8);
            this._opensDown = true;
        }
        if (top + H > monitor.y + monitor.height - 8)
            top = Math.max(monitor.y + 8, monitor.y + monitor.height - H - 8);

        this._root.set_position(Math.round(left), Math.round(top));

        // Grow out of the icon: pivot at the anchor's centre, on the edge
        // nearest the trigger (bottom for a top panel, top for a bottom bar).
        const px = clamp((ax + aw / 2 - left) / W, 0.08, 0.92);
        this._root.set_pivot_point(px, this._opensDown ? 0 : 1);
        this._root.translation_y = 0;
        this._root.set_scale(1, 1);

        this._strip.setViewport(H);
        this._strip.setItems(items, 0);
        this._strip.over(-1); // clear highlight state

        this._open = true;
        this._misses = 0;

        this._root.remove_all_transitions();
        this._root.show();
        this._root.opacity = 0;
        this._root.translation_y = this._opensDown ? -16 : 16;
        this._root.set_scale(0.96, 0.96);
        this._root.ease({
            opacity: 255,
            translation_y: 0,
            scale_x: 1, scale_y: 1,
            duration: 190,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    close(instant = false) {
        if (!this._open) return;
        this._open = false;
        this._strip.stopEdge();
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
            onComplete: () => {
                if (!this._open) this._root.hide();
            },
        });
        this._anchor = null;
    }

    destroy() {
        this._open = false;
        if (this._watchId) { this._scope.cancel(this._watchId); this._watchId = 0; }
        this._strip?.destroy();
        this._scope.dispose();
        try { Main.layoutManager.removeChrome(this._root); } catch (e) { /* already gone */ }
        this._root.destroy();
        this._root = null;
    }
}
