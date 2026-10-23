// ===== FILE: ./lib/pinnedEdgeFlyout.js =====
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import * as Scheduling from './scheduling.js';
import * as Interactions from './interactions.js';
import * as Motion from './motion.js';
import { S } from './sizes.js';
import { Poller, Misses } from './util.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

journal('[pinnedEdge] MODULE LOADED');

// ---- trigger tuning ----
const EDGE_PX = 8;
const DWELL_MS = 250;
const POLL_MS = 30;
const PRESSURE_THRESHOLD = 150;
const PRESSURE_TIMEOUT_MS = 400;

const BASE_ICON_SIZES = [16, 22, 24, 32, 48, 64, 96, 128, 160, 192, 224, 256];

// Shell versions store the app on different properties; try each.
const appOf = item => item?._app ?? item?.child?.app ?? item?.child?._app ?? null;

// ==================== EdgeDash ====================
const EdgeDash = GObject.registerClass(
    class EdgeDash extends Dash.Dash {
        _init(monitor, callbacks = {}) {
            super._init();

            journal('[pinnedEdge.dash] _init:enter');
            this._monitor = monitor;
            this._onShowApps = callbacks.onShowApps ?? null;
            this._onActivated = callbacks.onActivated ?? null;
            this._keepDashShown = false;
            this._destroying = false;

            this._forceVertical();

            this.reactive = true;
            this.track_hover = true;
            this._background.reactive = true;
            this._background.set_style('background: none; box-shadow: none; border: none;');

            this.set_pivot_point(0, 0.5);
            this.add_style_class_name('pinned-edge-dash');
            this.add_style_class_name('left');

            try {
                Main.layoutManager.addTopChrome(this, {
                    affectsInputRegion: true,
                    trackFullscreen: false,
                });
                journal('[pinnedEdge.dash] addTopChrome OK');
            } catch (e) {
                journal(`[pinnedEdge.dash] addTopChrome THREW: ${e.message}`);
            }

            try {
                this._showAppsIcon.visible = true;
                this.updateShowAppsButton();
            } catch (e) { /* ignore */ }

            this._setupShowAppsTooltip();

            if (this.showAppsButton) {
                this.showAppsButton.connect('button-press-event', (a, e) => {
                    if (e.get_button() !== Clutter.BUTTON_PRIMARY)
                        return Clutter.EVENT_PROPAGATE;
                    journal('[pinnedEdge.dash] Show Apps pressed');
                    this._onShowApps?.();
                    return Clutter.EVENT_STOP;
                });
            }

            this._setGeometry();
            this.connect('notify::width', () => this._setGeometry());
            this.connect('notify::height', () => this._setGeometry());

            this.connect('notify::visible', () => {
                if (!this.visible) Interactions.getTooltip().hideNow();
            });

            for (const delay of [0, 300, 1000]) {
                if (delay === 0) {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        if (this._destroying) return GLib.SOURCE_REMOVE;
                        this._forceIconSizes('idle');
                        this._hideNonFavoriteApps();
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                        if (this._destroying) return GLib.SOURCE_REMOVE;
                        this._forceIconSizes(`timeout-${delay}`);
                        this._hideNonFavoriteApps();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }

            journal('[pinnedEdge.dash] _init:exit');
        }

        _setupShowAppsTooltip() {
            const showApps = this._showAppsIcon;
            if (!showApps) return;

            this._suppressLabel(showApps);

            try {
                showApps.connect('notify::hover', () => {
                    if (showApps.hover) {
                        Interactions.getTooltip().showRight(
                            showApps.icon ?? showApps, 'Show Apps', S.dash.tooltipGap);
                    } else {
                        Interactions.getTooltip().hide();
                    }
                });
            } catch (e) {
                journal(`[pinnedEdge.dash] showApps hover hook failed: ${e.message}`);
            }
        }

        _suppressLabel(container) {
            const label = container?.label;
            if (!label) return;
            label.visible = false;
            label.connect('notify::visible', () => {
                if (label.visible) label.visible = false;
            });
        }

        _styleAppMenu(item) {
            const menu = item?._menu;
            if (!menu?.actor) return;
            try {
                if (!menu.actor.has_style_class_name('pinned-edge-menu'))
                    menu.actor.add_style_class_name('pinned-edge-menu');
            } catch (e) {
                journal(`[pinnedEdge.dash] menu style class failed: ${e.message}`);
            }
        }

        _forceVertical() {
            if (this._box) {
                try {
                    this._box.layout_manager = new Clutter.BoxLayout({
                        orientation: Clutter.Orientation.VERTICAL,
                    });
                } catch (e) {
                    journal(`[pinnedEdge.dash] layout swap failed: ${e.message}`);
                    try { this._box.vertical = true; } catch (e2) { /* ignore */ }
                }
                this._box.x_align = Clutter.ActorAlign.CENTER;
                this._box.y_align = Clutter.ActorAlign.START;
                this._box.x_expand = false;
                this._box.y_expand = true;
            }

            if (this._boxContainer) {
                try { this._boxContainer.vertical = true; } catch (e) { /* ignore */ }
                this._boxContainer.x_align = Clutter.ActorAlign.CENTER;
                this._boxContainer.y_align = Clutter.ActorAlign.START;
                this._boxContainer.x_expand = false;
                this._boxContainer.y_expand = true;
            }

            if (this._scrollView) {
                this._scrollView.hscrollbar_policy = St.PolicyType.NEVER;
                this._scrollView.vscrollbar_policy = St.PolicyType.EXTERNAL;
                this._scrollView.x_expand = false;
                this._scrollView.y_expand = true;
            }

            if (this._dashContainer) {
                try { this._dashContainer.vertical = true; } catch (e) { /* ignore */ }
                this._dashContainer.x_align = Clutter.ActorAlign.CENTER;
                this._dashContainer.y_align = Clutter.ActorAlign.CENTER;
                this._dashContainer.x_expand = false;
                this._dashContainer.y_expand = true;
            }

            if (this._showAppsIcon) {
                this._showAppsIcon.x_expand = false;
                this._showAppsIcon.y_expand = false;
                this._showAppsIcon.x_align = Clutter.ActorAlign.CENTER;
                this._showAppsIcon.y_align = Clutter.ActorAlign.START;
            }

            this.iconSize = S.dash.icon;

            journal(`[pinnedEdge.dash] _forceVertical box=${!!this._box} ` +
                `boxC=${!!this._boxContainer} scroll=${!!this._scrollView} ` +
                `dashC=${!!this._dashContainer} apps=${!!this._showAppsIcon} ` +
                `iconSize=${this.iconSize}`);
        }

        _initializeIconSize(maxSize) {
            this._availableIconSizes = BASE_ICON_SIZES.filter(v => v < maxSize);
            if (!this._availableIconSizes.includes(maxSize))
                this._availableIconSizes.push(maxSize);
            journal(`[pinnedEdge.dash] _initializeIconSize(${maxSize}) -> ` +
                `[${this._availableIconSizes.join(',')}]`);
        }

        _forceIconSizes(trigger = 'manual') {
            const SIZE = S.dash.icon;
            this.iconSize = SIZE;

            const children = this._box?.get_children() ?? [];
            let appResized = 0, appFailed = 0;

            for (const item of children) {
                const dashIcon = item?.child;
                const appIcon = dashIcon?.icon;
                if (!appIcon) { appFailed++; continue; }

                let ok = false;

                if (typeof appIcon.setIconSize === 'function') {
                    try { appIcon.setIconSize(SIZE); ok = true; }
                    catch (e) { journal(`[pinnedEdge.dash] setIconSize THREW: ${e.message}`); }
                }

                const stIcon = appIcon.icon;
                if (stIcon) {
                    try { stIcon.icon_size = SIZE; ok = true; } catch (e) { /* ignore */ }
                    try { stIcon.set_icon_size?.(SIZE); } catch (e) { /* ignore */ }
                }

                const container = appIcon._iconContainer;
                if (container) {
                    try { container.set_size(SIZE, SIZE); } catch (e) { /* ignore */ }
                }

                if (ok) appResized++; else appFailed++;
            }

            const appsIcon = this._showAppsIcon?.icon;
            if (appsIcon) {
                if (typeof appsIcon.setIconSize === 'function') {
                    try { appsIcon.setIconSize(SIZE); } catch (e) { /* ignore */ }
                }
                const stIcon = appsIcon.icon;
                if (stIcon) {
                    try { stIcon.icon_size = SIZE; } catch (e) { /* ignore */ }
                    try { stIcon.set_icon_size?.(SIZE); } catch (e) { /* ignore */ }
                }
            }

            journal(`[pinnedEdge.dash] _forceIconSizes[${trigger}] ` +
                `children=${children.length} resized=${appResized} failed=${appFailed} ` +
                `iconSize=${this.iconSize}`);
        }

        // The shell dash shows favorites PLUS running apps that are not
        // pinned. This dash is favorites-only, so drop everything that
        // isn't a favorite and drop the running-apps separator.
        _hideNonFavoriteApps() {
            const favorites = new Set(
                AppFavorites.getAppFavorites().getFavorites().map(a => a.get_id()));

            const children = this._box?.get_children() ?? [];
            let hidden = 0;
            for (const item of children) {
                if (item === this._showAppsIcon) {
                    item.visible = true;
                    continue;
                }
                const app = appOf(item);
                const id = app?.get_id?.();
                if (id) {
                    const show = favorites.has(id);
                    item.visible = show;
                    if (!show) hidden++;
                } else {
                    // separator or any shell chrome without an app id
                    item.visible = false;
                    hidden++;
                }
            }
            if (this._separator) this._separator.visible = false;

            if (hidden)
                journal(`[pinnedEdge.dash] _hideNonFavoriteApps hid ${hidden} non-favorite item(s)`);
        }

        _adjustIconSize() {
            this._forceIconSizes('_adjustIconSize');
            this._hideNonFavoriteApps();
        }

        _redisplay() {
            super._redisplay();
            this._forceIconSizes('_redisplay');
            this._hideNonFavoriteApps();
        }

        _createAppItem(app) {
            const item = super._createAppItem(app);

            this._suppressLabel(item);
            this._styleAppMenu(item);

            const dashIcon = item?.child;
            if (!dashIcon) return item;

            try {
                dashIcon.connect('clicked', () => {
                    journal(`[pinnedEdge.dash] icon clicked: ${app.get_name?.() ?? ''}`);
                    this._onActivated?.();
                });
            } catch (e) { /* ignore */ }

            try {
                dashIcon.connect('notify::hover', () => {
                    if (dashIcon.hover) {
                        Interactions.getTooltip().showRight(
                            dashIcon, app.get_name?.() ?? '', S.dash.tooltipGap);
                    } else {
                        Interactions.getTooltip().hide();
                    }
                });
            } catch (e) { /* ignore */ }

            const appIcon = dashIcon.icon;
            if (appIcon) {
                if (typeof appIcon.setIconSize === 'function') {
                    try { appIcon.setIconSize(S.dash.icon); } catch (e) { /* ignore */ }
                }
                const stIcon = appIcon.icon;
                if (stIcon) {
                    try { stIcon.icon_size = S.dash.icon; } catch (e) { /* ignore */ }
                }
            }

            return item;
        }

        _setGeometry() {
            if (!this._monitor) return;
            if (this._setGeometryTimeout) {
                GLib.Source.remove(this._setGeometryTimeout);
                this._setGeometryTimeout = 0;
            }

            this._setGeometryTimeout = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._setGeometryTimeout = 0;
                if (!this._monitor) return GLib.SOURCE_REMOVE;

                const { width, height, x, y } = this._monitor;
                const maxW = Math.round(width * 0.35);
                const maxH = Math.round(height * 0.90);
                this.setMaxSize(maxW, maxH);

                const w = this.width || 0;
                const h = this.height || 0;
                const nx = x;
                const ny = y + Math.round((height - h) / 2);
                this.set_position(nx, Math.max(y, ny));

                journal(`[pinnedEdge.dash] _setGeometry pos=${nx},${Math.max(y, ny)} ` +
                    `size=${w}x${h} max=${maxW}x${maxH}`);
                return GLib.SOURCE_REMOVE;
            });
        }

        _itemMenuStateChanged(item, opened) {
            super._itemMenuStateChanged(item, opened);
            this._keepDashShown = !!opened;
            if (opened) {
                this._styleAppMenu(item);
                Interactions.getTooltip().hideNow();
            }
            journal(`[pinnedEdge.dash] menu ${opened ? 'opened' : 'closed'}`);
        }

        // ---------- drag & drop reorder ----------
        // Visible favorite tiles, top to bottom. Non-favorites are hidden by
        // _hideNonFavoriteApps, so index here == index in the favorites list.
        _favoriteItems() {
            return (this._box?.get_children() ?? []).filter(i =>
                i.visible && i !== this._showAppsIcon && appOf(i));
        }

        // Insertion slot (0..n) for pointer y: count tiles whose midpoint is above it.
        _slotAt(y) {
            const items = this._favoriteItems();
            let pos = 0;
            for (const it of items) {
                const [, iy] = it.get_transformed_position();
                const [, ih] = it.get_transformed_size();
                if (y > iy + ih / 2) pos++;
            }
            return { items, pos };
        }

        _ensureDropLine() {
            if (this._dropLine) return this._dropLine;
            this._dropLine = new St.Widget({
                style_class: 'dash-drop-line', reactive: false, visible: false,
            });
            Main.layoutManager.addTopChrome(this._dropLine,
                { affectsInputRegion: false, trackFullscreen: false });
            return this._dropLine;
        }

        _showDropLine(items, pos) {
            if (!items.length) { this._hideDropLine(); return; }
            const line = this._ensureDropLine();
            const ref = items[Math.min(pos, items.length - 1)];
            const [rx, ry] = ref.get_transformed_position();
            const [rw, rh] = ref.get_transformed_size();
            const y = pos < items.length ? ry : ry + rh;
            line.set_size(Math.round(rw), 6);
            line.set_position(Math.round(rx), Math.round(y - 3));
            line.show();
            Main.layoutManager.uiGroup.set_child_above_sibling(line, null);
        }

        _hideDropLine() { this._dropLine?.hide(); }

        // Called by the shell on drag end and when the pointer leaves the box.
        _clearDragPlaceholder() {
            this._hideDropLine();
            super._clearDragPlaceholder();
        }

        // Keep the dash open for the whole drag, even if the poll sees the
        // pointer momentarily outside it.
        _onItemDragBegin(...args) {
            this._keepDashShown = true;
            super._onItemDragBegin(...args);
        }
        _onItemDragEnd(...args) {
            this._keepDashShown = false;
            this._hideDropLine();
            super._onItemDragEnd(...args);
        }
        _onItemDragCancelled(...args) {
            this._keepDashShown = false;
            this._hideDropLine();
            super._onItemDragCancelled(...args);
        }

        handleDragOver(source, _actor, _x, _y, _time) {
            const app = source?.app;
            if (!app || app.is_window_backed()) return DND.DragMotionResult.NO_DROP;
            const [, py] = global.get_pointer();
            const { items, pos } = this._slotAt(py);
            this._showDropLine(items, pos);
            return DND.DragMotionResult.MOVE_DROP;
        }

        acceptDrop(source, _actor, _x, _y, _time) {
            const app = source?.app;
            if (!app || app.is_window_backed()) return false;

            const [, py] = global.get_pointer();
            const { pos } = this._slotAt(py);
            this._hideDropLine();

            const favs = AppFavorites.getAppFavorites();
            const id = app.get_id();
            const cur = favs.getFavorites().map(a => a.get_id()).indexOf(id);

            if (cur >= 0) {
                // moveFavoriteToPos removes first, so slots below the source shift up by one.
                const to = cur < pos ? pos - 1 : pos;
                if (to !== cur) favs.moveFavoriteToPos(id, to);
            } else {
                favs.addFavoriteAtPos(id, pos);
            }
            return true;
        }

        destroy() {
            this._destroying = true;
            Interactions.getTooltip().hideNow();
            if (this._dropLine) {
                try { Main.layoutManager.removeChrome(this._dropLine); } catch (e) { /* gone */ }
                try { this._dropLine.destroy(); } catch (e) { /* gone */ }
                this._dropLine = null;
            }
            if (this._setGeometryTimeout) {
                GLib.Source.remove(this._setGeometryTimeout);
                this._setGeometryTimeout = 0;
            }
            if (this.get_parent() === Main.layoutManager.uiGroup)
                Main.layoutManager.removeChrome(this);
            super.destroy();
        }
    });

// ==================== PinnedEdgeFlyout ====================
export class PinnedEdgeFlyout {
    constructor(settings = null, callbacks = {}) {
        journal('[pinnedEdge] constructor:enter');

        this._settings = settings;
        this._onShowAppsCb = callbacks.onShowApps ?? null;
        this._scope = new Scheduling.Scope();

        this._dash = null;
        this._open = false;
        this._edgeSince = 0;

        // Suppression: window grab in flight, or pointer still parked on the
        // edge after a grab ended (must leave the zone once to re-arm).
        this._grabActive = false;
        this._needLeave = false;

        this._poll = new Poller(this._scope, {
            interval: POLL_MS,
            name: 'pinnedEdge',
            tick: () => this._tick(),
        });

        this._pressureBarrier = null;
        this._barrier = null;
        this._barrierKey = null;
        this._barrierIdleId = 0;

        this._scope.connect(global.display, 'grab-op-begin', () => {
            this._grabActive = true;
            this._edgeSince = 0;
            this._close('grab');
        });
        this._scope.connect(global.display, 'grab-op-end', () => {
            this._grabActive = false;
            this._edgeSince = 0;
            this._needLeave = true;
        });

        this._installBarrierDeferred();
        this._poll.start();

        this._scope.connect(Main.layoutManager, 'monitors-changed', () => {
            journal('[pinnedEdge] monitors changed — rebuilding');
            if (this._dash) {
                try { this._dash.destroy(); } catch (e) { /* gone */ }
                this._dash = null;
            }
            this._open = false;
            this._removeBarrier();
            this._barrierKey = null;
            this._installBarrierDeferred();
        });

        journal('[pinnedEdge] constructor:exit');
    }

    // ---------- geometry ----------
    _hasLeftNeighbor(monitor) {
        return Main.layoutManager.monitors.some(other =>
            other !== monitor
            && other.x + other.width <= monitor.x
            && other.y < monitor.y + monitor.height
            && other.y + other.height > monitor.y);
    }

    _zone() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._dash || this._hasLeftNeighbor(m)) return null;

        let h = 0;
        try {
            h = (this._dash.visible && this._dash.height > 0)
                ? this._dash.height
                : this._dash.get_preferred_height(-1)[1];
        } catch (e) { h = 0; }

        h = Math.min(Math.round(h), Math.round(m.height * 0.90));
        if (!Number.isFinite(h) || h <= 0) return null;

        const y1 = m.y + Math.round((m.height - h) / 2);
        return { x1: m.x, x2: m.x + EDGE_PX, y1, y2: y1 + h };
    }

    _inZone(zone, x, y) {
        return !!zone && x >= zone.x1 && x <= zone.x2 && y >= zone.y1 && y < zone.y2;
    }

    _zoneKey(zone) {
        return zone ? `${zone.x1},${zone.y1},${zone.y2}` : '';
    }

    _ensureDash() {
        if (this._dash) return true;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) {
            journal('[pinnedEdge] _ensureDash: no primary monitor');
            return false;
        }
        try {
            this._dash = new EdgeDash(monitor, {
                onShowApps: () => this._handleShowApps(),
                onActivated: () => this._close('activate'),
            });
            this._dash.hide();
            this._dash.opacity = 0;
            this._dash.set_scale(0, 1);

            this._scope.connect(this._dash, 'leave-event', () => {
                if (!this._open || this._dash?._keepDashShown)
                    return Clutter.EVENT_PROPAGATE;
                const [x, y] = global.get_pointer();
                if (!this._pointerOverDash(x, y) && !this._inZone(this._zone(), x, y))
                    this._close('leave');
                return Clutter.EVENT_PROPAGATE;
            });

            journal('[pinnedEdge] _ensureDash: created');
            return true;
        } catch (e) {
            journal(`[pinnedEdge] _ensureDash THREW: ${e.message}\n${e.stack}`);
            this._dash = null;
            return false;
        }
    }

    _handleShowApps() {
        journal('[pinnedEdge] show-apps requested');
        this._close('show-apps');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, Motion.dur('dashClose') + 20, () => {
            this._onShowAppsCb?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- barrier ----------
    _installBarrierDeferred() {
        if (this._barrierIdleId) return;
        this._barrierIdleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._barrierIdleId = 0;
            try { this._installBarrier(); }
            catch (e) { journal(`[pinnedEdge.barrier] THREW: ${e.message}\n${e.stack}`); }
            return GLib.SOURCE_REMOVE;
        });
    }

    _installBarrier() {
        if (!this._ensureDash()) return;
        const zone = this._zone();
        this._barrierKey = this._zoneKey(zone);
        if (!zone) {
            journal('[pinnedEdge.barrier] no zone — SKIP');
            return;
        }

        const y1 = zone.y1 + 1;
        const y2 = zone.y2 - 1;
        const xBarrier = zone.x1 + 1;
        if (y2 <= y1) return;

        try {
            this._pressureBarrier = new Layout.PressureBarrier(
                PRESSURE_THRESHOLD,
                PRESSURE_TIMEOUT_MS,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        } catch (e) {
            journal(`[pinnedEdge.barrier] PressureBarrier THREW: ${e.message}`);
            return;
        }

        try {
            this._barrier = new Meta.Barrier({
                backend: global.backend,
                x1: xBarrier, y1,
                x2: xBarrier, y2,
                directions: Meta.BarrierDirection.POSITIVE_X,
            });
        } catch (e) {
            journal(`[pinnedEdge.barrier] Meta.Barrier THREW: ${e.message}`);
            this._pressureBarrier = null;
            return;
        }

        try { this._pressureBarrier.addBarrier(this._barrier); }
        catch (e) { journal(`[pinnedEdge.barrier] addBarrier THREW: ${e.message}`); }

        this._scope.connect(this._pressureBarrier, 'trigger', () => {
            if (this._open || this._grabActive || this._needLeave) return;
            const [, , mods] = global.get_pointer();
            if (mods & Clutter.ModifierType.BUTTON1_MASK) return;
            this._show('barrier');
        });

        journal(`[pinnedEdge.barrier] installed x=${xBarrier} y=[${y1},${y2}]`);
    }

    _removeBarrier() {
        if (this._barrier) {
            try { this._pressureBarrier?.removeBarrier(this._barrier); } catch (e) { /* gone */ }
            try { this._barrier.destroy(); } catch (e) { /* gone */ }
            this._barrier = null;
        }
        if (this._pressureBarrier) {
            try { this._pressureBarrier.destroy(); } catch (e) { /* gone */ }
            this._pressureBarrier = null;
        }
    }

    _syncBarrier(zone) {
        if (this._open || this._barrierIdleId) return;
        const key = this._zoneKey(zone);
        if (key === this._barrierKey) return;
        this._removeBarrier();
        this._installBarrierDeferred();
    }

    // ---------- poll ----------
    _tick() {
        if (!this._dash && !this._ensureDash()) return;

        const [x, y, mods] = global.get_pointer();
        const zone = this._zone();
        this._syncBarrier(zone);

        const atEdge = this._inZone(zone, x, y);
        if (!atEdge) this._needLeave = false;

        if (!this._open) {
            const blocked = this._grabActive || this._needLeave ||
                (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
            if (!atEdge || blocked) { this._edgeSince = 0; return; }

            const now = GLib.get_monotonic_time() / 1000;
            if (!this._edgeSince) { this._edgeSince = now; return; }
            if (now - this._edgeSince >= DWELL_MS) {
                this._edgeSince = 0;
                this._show('dwell');
            }
            return;
        }

        if (this._dash?._keepDashShown) return;
        if (this._dash?.hover || this._pointerOverDash(x, y) || atEdge) return;

        this._close('left');
    }

    _pointerOverDash(x, y) {
        if (!this._dash || !this._dash.visible) return false;
        const [rx, ry] = this._dash.get_transformed_position();
        const [rw, rh] = this._dash.get_transformed_size();
        if (![rx, ry, rw, rh].every(Number.isFinite)) return false;
        return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
    }

    // ---------- show / close ----------
    _show(source = '?') {
        if (this._open || this._grabActive) return;
        if (!this._ensureDash()) {
            journal('[pinnedEdge] _show: dash unavailable — ABORT');
            return;
        }

        journal(`[pinnedEdge] _show source=${source}`);

        this._dash.remove_all_transitions();
        this._dash.set_scale(0, 1);
        this._dash.opacity = 0;
        this._dash.reactive = true;
        this._dash.show();

        this._dash._forceIconSizes('show');
        this._dash._hideNonFavoriteApps();

        Motion.animate(this._dash, { scale_x: 1, opacity: 255 },
            { duration: 'dashOpen', mode: Clutter.AnimationMode.EASE_OUT_CUBIC });

        this._open = true;
        this._edgeSince = 0;
    }

    _close(source = '?') {
        if (!this._open) return;
        journal(`[pinnedEdge] _close source=${source}`);
        this._open = false;
        this._edgeSince = 0;

        if (!this._dash) return;

        Interactions.getTooltip().hideNow();

        this._dash.reactive = false;
        this._dash.remove_all_transitions();
        Motion.animate(this._dash, { scale_x: 0, opacity: 0 }, {
            duration: 'dashClose',
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._open && this._dash) {
                    this._dash.hide();
                    this._dash.set_scale(1, 1);
                }
            },
        });
    }

    destroy() {
        journal('[pinnedEdge] destroy:enter');
        this._open = false;

        this._poll.stop();
        if (this._barrierIdleId) {
            try { GLib.Source.remove(this._barrierIdleId); } catch (e) { /* gone */ }
            this._barrierIdleId = 0;
        }
        this._removeBarrier();

        if (this._dash) {
            try { this._dash.destroy(); } catch (e) { /* gone */ }
            this._dash = null;
        }

        this._scope.dispose();
        journal('[pinnedEdge] destroy:exit');
    }
}