// ===== FILE: ./lib/pinnedEdgeFlyout.js =====
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
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
const POLL_MS = 80;
const MISS_LIMIT = 10;
const PRESSURE_THRESHOLD = 150;
const PRESSURE_TIMEOUT_MS = 400;
const BARRIER_TOP_PAD = 8;
const BARRIER_BOTTOM_PAD = 8;
const GRACE_MS = 700;

const BASE_ICON_SIZES = [16, 22, 24, 32, 48, 64, 96, 128, 160, 192, 224, 256];

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
        // pinned. Running-but-unpinned apps (e.g. the Extensions settings
        // window `org.gnome.Shell.Extensions` spawned by Extension Manager)
        // have no proper icon and render as a blank tile. This dash is
        // favorites-only, so drop everything that isn't a favorite and
        // drop the running-apps separator.
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
                const app = item?._app ?? item?.child?.app ?? item?.child?._app;
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

        destroy() {
            this._destroying = true;
            Interactions.getTooltip().hideNow();
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
        this._openTime = 0;
        this._edgeSince = 0;
        this._lastAtEdge = false;

        this._poll = new Poller(this._scope, {
            interval: POLL_MS,
            name: 'pinnedEdge',
            tick: () => this._tick(),
        });
        this._missCount = new Misses(MISS_LIMIT, () => {
            journal('[pinnedEdge.poll] miss limit -> close');
            this._close('poll-miss');
        });

        this._pressureBarrier = null;
        this._barrier = null;
        this._barrierIdleId = 0;

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
            this._installBarrierDeferred();
        });

        journal('[pinnedEdge] constructor:exit');
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

    _installBarrierDeferred() {
        if (this._barrierIdleId) return;
        journal('[pinnedEdge.barrier] scheduling in 200ms');
        this._barrierIdleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._barrierIdleId = 0;
            journal('[pinnedEdge.barrier] firing now');
            try { this._installBarrier(); }
            catch (e) { journal(`[pinnedEdge.barrier] THREW: ${e.message}\n${e.stack}`); }
            return GLib.SOURCE_REMOVE;
        });
    }

    _installBarrier() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) {
            journal('[pinnedEdge.barrier] no primary monitor — SKIP');
            return;
        }

        const leftNeighborExists = Main.layoutManager.monitors.some(other =>
            other !== monitor
            && other.x + other.width <= monitor.x
            && other.y < monitor.y + monitor.height
            && other.y + other.height > monitor.y);
        if (leftNeighborExists) {
            journal('[pinnedEdge.barrier] left neighbour exists — SKIP');
            return;
        }

        const panelH = Main.panel?.height ?? 0;
        const y1 = monitor.y + panelH + BARRIER_TOP_PAD + 1;
        const y2 = monitor.y + monitor.height - BARRIER_BOTTOM_PAD - 1;
        const xBarrier = monitor.x + 1;
        if (y2 <= y1) {
            journal('[pinnedEdge.barrier] y2<=y1 — SKIP');
            return;
        }

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
            journal(`[pinnedEdge.barrier] *** TRIGGER *** (open=${this._open})`);
            if (this._open) return;
            this._show('barrier');
        });

        journal(`[pinnedEdge.barrier] installed x=${xBarrier} y=[${y1},${y2}] dir=POSITIVE_X`);
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

    _tick() {
        const [x, y] = global.get_pointer();
        const panelH = Main.panel?.height ?? 0;
        const monitor = Main.layoutManager.primaryMonitor;
        const inPrimary = monitor
            && y >= monitor.y
            && y < monitor.y + monitor.height;
        const atEdge = x <= EDGE_PX && y > panelH + 4 && inPrimary;

        if (atEdge !== this._lastAtEdge) {
            journal(`[pinnedEdge.poll] atEdge ${this._lastAtEdge}->${atEdge} ` +
                `x=${x} y=${y} panelH=${panelH}`);
            this._lastAtEdge = atEdge;
        }

        if (!this._open) {
            if (!atEdge) { this._edgeSince = 0; return; }
            const now = GLib.get_monotonic_time() / 1000;
            if (!this._edgeSince) {
                this._edgeSince = now;
                journal('[pinnedEdge.poll] dwell started');
                return;
            }
            if (now - this._edgeSince >= DWELL_MS) {
                this._edgeSince = 0;
                this._show('dwell');
            }
            return;
        }

        const now = GLib.get_monotonic_time() / 1000;
        const inGrace = now - this._openTime < GRACE_MS;

        if (this._dash?._keepDashShown) {
            if (this._missCount.n) journal('[pinnedEdge.poll] menu-open -> reset');
            this._missCount.reset();
            return;
        }
        if (this._dash?.hover) {
            if (this._missCount.n) journal(`[pinnedEdge.poll] dash-hover -> reset (${this._missCount.n})`);
            this._missCount.reset();
            return;
        }

        const over = this._pointerOverDash(x, y);
        if (atEdge || over) {
            if (this._missCount.n) journal(`[pinnedEdge.poll] reacquired (${this._missCount.n})`);
            this._missCount.reset();
            return;
        }
        if (inGrace) return;

        this._missCount.miss();
    }

    _pointerOverDash(x, y) {
        if (!this._dash || !this._dash.visible) return false;
        const [rx, ry] = this._dash.get_transformed_position();
        const [rw, rh] = this._dash.get_transformed_size();
        if (![rx, ry, rw, rh].every(Number.isFinite)) return false;
        return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
    }

    _show(source = '?') {
        if (this._open) return;
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
        this._openTime = GLib.get_monotonic_time() / 1000;
        this._missCount.reset();
        this._edgeSince = 0;
    }

    _close(source = '?') {
        if (!this._open) return;
        journal(`[pinnedEdge] _close source=${source}`);
        this._open = false;
        this._missCount.reset();
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