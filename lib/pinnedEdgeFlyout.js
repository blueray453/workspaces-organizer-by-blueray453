// ===== FILE: ./lib/pinnedEdgeFlyout.js =====
// Left-edge vertical dash: pinned apps in a single column, parked against
// the left screen edge, vertically centered.
//
// Large icons: the shell's Dash.Dash caps icon sizes at 128 (baseIconSizes
// max) and picks the largest that fits, which for 13 apps in a column is
// well under 128. This class overrides:
//   • _initializeIconSize — allow up to 256
//   • _adjustIconSize    — force ICON_SIZE on every child, bypassing the
//                          "largest that fits" logic entirely
//   • _redisplay         — call super._redisplay, then re-force sizes
// Every icon is reached via item.child.icon (the AppIcon) — NOT via the
// unreliable item.child._delegate path, which is often undefined on the
// shell's base Dash.
//
// Tooltip: the shell's per-item labels are suppressed. One shared
// St.Label is created in _init, parented to layoutManager's uiGroup, and
// driven by per-icon hover signals. Moving between icons EASES the label
// from one anchor to the next instead of hide→show→snap, so the tooltip
// no longer re-renders on every hover. It fades out only when the
// pointer leaves the dash.
//
// No truncation:
//   • The label's clutter_text has ellipsize NONE, wrap off, and single
//     line mode on — re-asserted on every show, so no CSS rule, theme,
//     or shell upgrade can re-enable "…".
//   • The label is sized from its natural width (get_preferred_width(-1))
//     rather than any inherited allocation.
//   • The position is clamped to the monitor; if the natural width would
//     overflow the monitor's right edge, the tooltip is placed to the
//     LEFT of the icon instead. Long app names are never cut off by the
//     screen edge.
// Styling lives in stylesheet.css under `.topnotch-tooltip.pinned-edge-
// tooltip` — nothing is applied per hover.
//
// Debug:
//   journalctl -f -o cat /usr/bin/gnome-shell | grep pinnedEdge

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Scheduling from './scheduling.js';

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

// ---- animation ----
const OPEN_MS = 180;
const CLOSE_MS = 140;

// ---- icons / tooltips ----
const ICON_SIZE = 96;
const TOOLTIP_GAP = 20;             // gap between icon edge and tooltip
const TOOLTIP_HIDE_MS = 80;         // grace before fade-out (dash-level only)
const TOOLTIP_FADE_MS = 120;
const TOOLTIP_MOVE_MS = 150;
const TOOLTIP_EDGE_PAD = 12;        // min distance from monitor edges

// Extended base size ladder — bypasses the shell's 128 cap.
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
            this._getTooltipFontSize = callbacks.getTooltipFontSize ?? (() => null);
            this._keepDashShown = false;
            this._destroying = false;

            // ---- shared tooltip state ----
            this._tooltip = null;
            this._tooltipHideId = 0;

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

            this._styleLabel(this._showAppsIcon);
            this._createTooltip();
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

            // Hide tooltip when the dash itself goes away (flyout closes).
            this.connect('notify::visible', () => {
                if (!this.visible) this._hideTooltip(true);
            });
            // Cancel / schedule tooltip hide based on dash-level hover.
            this.connect('notify::hover', () => {
                if (this.hover) this._cancelTooltipHide();
                else this._scheduleHideTooltip();
            });

            // Force sizing three times: once on the next idle, once after
            // 300 ms, once after 1 s. Covers the initial render, the deferred
            // _redisplay finishing, and any late parent adjustment.
            for (const delay of [0, 300, 1000]) {
                if (delay === 0) {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        if (this._destroying) return GLib.SOURCE_REMOVE;
                        this._forceIconSizes('idle');
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                        if (this._destroying) return GLib.SOURCE_REMOVE;
                        this._forceIconSizes(`timeout-${delay}`);
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }

            journal('[pinnedEdge.dash] _init:exit');
        }

        // ==================== shared tooltip ====================
        _createTooltip() {
            this._tooltip = new St.Label({
                style_class: 'topnotch-tooltip pinned-edge-tooltip',
                visible: false,
                reactive: false,
                x_expand: false,
                y_expand: false,
            });

            // No truncation, ever. This is re-asserted on every show because
            // a CSS rule, a theme, or a shell upgrade could otherwise
            // re-enable ellipsize on the actor.
            this._enforceNoTruncation();

            try {
                Main.layoutManager.addChrome(this._tooltip, {
                    affectsInputRegion: false,
                    trackFullscreen: false,
                });
            } catch (e) {
                journal(`[pinnedEdge.dash] addChrome(tooltip) failed: ${e.message}`);
            }
        }

        _enforceNoTruncation() {
            if (!this._tooltip) return;
            const ct = this._tooltip.clutter_text;
            ct.set_ellipsize(Pango.EllipsizeMode.NONE);
            ct.set_line_wrap(false);
            ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            ct.set_single_line_mode(true);
        }

        _setupShowAppsTooltip() {
            const showApps = this._showAppsIcon;
            if (!showApps) return;

            // Suppress the built-in label — the shared tooltip replaces it.
            this._suppressLabel(showApps);

            try {
                showApps.connect('notify::hover', () => {
                    if (showApps.hover) {
                        this._showTooltipAt(showApps.icon ?? showApps, 'Show Apps');
                    } else {
                        this._scheduleHideTooltip();
                    }
                });
            } catch (e) {
                journal(`[pinnedEdge.dash] showApps hover hook failed: ${e.message}`);
            }
        }

        /** Hide a DashItemContainer's built-in label and keep it hidden. */
        _suppressLabel(container) {
            const label = container?.label;
            if (!label) return;
            label.visible = false;
            label.connect('notify::visible', () => {
                if (label.visible) label.visible = false;
            });
        }

        _cancelTooltipHide() {
            if (this._tooltipHideId) {
                GLib.Source.remove(this._tooltipHideId);
                this._tooltipHideId = 0;
            }
        }

        _showTooltipAt(icon, name) {
            this._cancelTooltipHide();
            if (!this._tooltip || !name) return;

            this._tooltip.set_text(name);
            this._tooltip.remove_all_transitions();
            this._enforceNoTruncation();

            // Natural width, not any computed/squeezed width.
            const [, natW] = this._tooltip.get_preferred_width(-1);
            const [, natH] = this._tooltip.get_preferred_height(natW);

            try {
                const [stageX, stageY] = icon.get_transformed_position();
                const iconW = icon.get_width();
                const iconH = icon.get_height();

                const monitorIndex = Main.layoutManager.findIndexForActor(icon);
                const monitor = Main.layoutManager.monitors[monitorIndex]
                    ?? Main.layoutManager.primaryMonitor;

                const pad = TOOLTIP_EDGE_PAD;

                // Prefer to the right of the icon. If the natural width
                // would push past the monitor's right edge, fall back to
                // the left of the icon so no character is off-screen.
                let targetX = Math.floor(stageX + iconW + TOOLTIP_GAP);
                if (targetX + natW > monitor.x + monitor.width - pad) {
                    targetX = Math.floor(stageX - natW - TOOLTIP_GAP);
                }
                targetX = Math.max(monitor.x + pad,
                    Math.min(targetX, monitor.x + monitor.width - natW - pad));

                let targetY = Math.floor(stageY + (iconH - natH) / 2);
                targetY = Math.max(monitor.y + pad,
                    Math.min(targetY, monitor.y + monitor.height - natH - pad));

                if (!this._tooltip.visible) {
                    this._tooltip.set_position(targetX, targetY);
                    this._tooltip.show();
                    this._tooltip.opacity = 0;
                    this._tooltip.ease({
                        opacity: 255,
                        duration: TOOLTIP_FADE_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } else {
                    this._tooltip.ease({
                        x: targetX,
                        y: targetY,
                        opacity: 255,
                        duration: TOOLTIP_MOVE_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
            } catch (e) {
                journal(`[pinnedEdge.dash] tooltip position failed: ${e.message}`);
            }
        }

        _scheduleHideTooltip() {
            if (this._tooltipHideId) return;
            this._tooltipHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_HIDE_MS, () => {
                this._tooltipHideId = 0;
                // Only actually hide when the pointer is outside the dash.
                // Moving icon → icon keeps dash.hover true, so the tooltip
                // stays up and simply eases to the new anchor.
                if (!this.hover) this._hideTooltip(false);
                return GLib.SOURCE_REMOVE;
            });
        }

        _hideTooltip(instant) {
            this._cancelTooltipHide();
            if (!this._tooltip || !this._tooltip.visible) return;
            this._tooltip.remove_all_transitions();

            if (instant) {
                this._tooltip.hide();
                this._tooltip.opacity = 0;
                return;
            }

            this._tooltip.ease({
                opacity: 0,
                duration: TOOLTIP_FADE_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (this._tooltip) this._tooltip.hide();
                },
            });
        }

        // ==================== base label helper ====================
        /** Kept for the Show Apps label as a safety net; app labels are suppressed. */
        _styleLabel(container) {
            const label = container?.label;
            if (!label) return;
            label.remove_style_class_name('dash-label');
            label.add_style_class_name('topnotch-tooltip');
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

            this.iconSize = ICON_SIZE;

            journal(`[pinnedEdge.dash] _forceVertical box=${!!this._box} ` +
                `boxC=${!!this._boxContainer} scroll=${!!this._scrollView} ` +
                `dashC=${!!this._dashContainer} apps=${!!this._showAppsIcon} ` +
                `iconSize=${this.iconSize}`);
        }

        /**
         * Bypass the shell's 128 cap. Called explicitly in _init so
         * _availableIconSizes includes ICON_SIZE from the start.
         */
        _initializeIconSize(maxSize) {
            this._availableIconSizes = BASE_ICON_SIZES.filter(v => v < maxSize);
            if (!this._availableIconSizes.includes(maxSize))
                this._availableIconSizes.push(maxSize);
            journal(`[pinnedEdge.dash] _initializeIconSize(${maxSize}) -> ` +
                `[${this._availableIconSizes.join(',')}]`);
        }

        /**
         * The single source of truth for icon sizing. Forces ICON_SIZE on:
         *   • every app icon's St.Icon (via icon_size property AND set_icon_size)
         *   • every app icon's _iconContainer (set_size)
         *   • the Show Apps icon (same way)
         * Logs each call so you can see which invocation is effective.
         */
        _forceIconSizes(trigger = 'manual') {
            const SIZE = ICON_SIZE;
            this.iconSize = SIZE;

            const children = this._box?.get_children() ?? [];
            let appResized = 0, appFailed = 0;

            for (const item of children) {
                const dashIcon = item?.child;
                const appIcon = dashIcon?.icon;
                if (!appIcon) { appFailed++; continue; }

                let ok = false;

                // 1. Preferred path: AppIcon.setIconSize(size)
                if (typeof appIcon.setIconSize === 'function') {
                    try { appIcon.setIconSize(SIZE); ok = true; }
                    catch (e) { journal(`[pinnedEdge.dash] setIconSize THREW: ${e.message}`); }
                }

                // 2. Direct St.Icon property, in case setIconSize clamps
                const stIcon = appIcon.icon;
                if (stIcon) {
                    try { stIcon.icon_size = SIZE; ok = true; } catch (e) { /* ignore */ }
                    try { stIcon.set_icon_size?.(SIZE); } catch (e) { /* ignore */ }
                }

                // 3. The wrapping container, in case it's what clips
                const container = appIcon._iconContainer;
                if (container) {
                    try { container.set_size(SIZE, SIZE); } catch (e) { /* ignore */ }
                }

                if (ok) appResized++; else appFailed++;
            }

            // Show Apps icon — same treatment
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

        /**
         * Override parent's auto-shrink. We always want ICON_SIZE regardless
         * of what the width/height solver thinks.
         */
        _adjustIconSize() {
            this._forceIconSizes('_adjustIconSize');
        }

        /**
         * Override _redisplay to re-force sizes after the parent's display
         * logic runs. The parent's _redisplay calls _adjustIconSize (ours),
         * but a second pass through _forceIconSizes ensures any items the
         * parent resized as part of insertion/filtering settle at ICON_SIZE.
         */
        _redisplay() {
            super._redisplay();
            this._forceIconSizes('_redisplay');
        }

        _createAppItem(app) {
            const item = super._createAppItem(app);

            // Suppress the built-in per-item label. A single shared tooltip
            // (this._tooltip) replaces every label, so hide → show → snap
            // on icon-to-icon moves disappears entirely.
            this._suppressLabel(item);

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
                        this._showTooltipAt(dashIcon, app.get_name?.() ?? '');
                    } else {
                        this._scheduleHideTooltip();
                    }
                });
            } catch (e) { /* ignore */ }

            // Force size immediately so the very first frame is correct.
            const appIcon = dashIcon.icon;
            if (appIcon) {
                if (typeof appIcon.setIconSize === 'function') {
                    try { appIcon.setIconSize(ICON_SIZE); } catch (e) { /* ignore */ }
                }
                const stIcon = appIcon.icon;
                if (stIcon) {
                    try { stIcon.icon_size = ICON_SIZE; } catch (e) { /* ignore */ }
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
            if (opened) this._hideTooltip(true);
            journal(`[pinnedEdge.dash] menu ${opened ? 'opened' : 'closed'}`);
        }

        destroy() {
            this._destroying = true;

            this._cancelTooltipHide();
            if (this._tooltip) {
                try { Main.layoutManager.removeChrome(this._tooltip); } catch (e) { /* gone */ }
                try { this._tooltip.destroy(); } catch (e) { /* gone */ }
                this._tooltip = null;
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
        this._openTime = 0;
        this._edgeSince = 0;
        this._misses = 0;
        this._pollId = 0;

        this._pressureBarrier = null;
        this._barrier = null;
        this._barrierIdleId = 0;

        this._lastAtEdge = false;

        this._installBarrierDeferred();
        this._startPoll();

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
                getTooltipFontSize: () => this._settings?.get_int('tooltip-font-size') ?? null,
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
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_MS + 20, () => {
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

    _startPoll() {
        if (this._pollId) return;
        journal(`[pinnedEdge.poll] starting (POLL_MS=${POLL_MS})`);
        this._pollId = this._scope.timeout(POLL_MS, () => {
            try { this._tick(); }
            catch (e) { journal(`[pinnedEdge.poll] THREW: ${e.message}\n${e.stack}`); }
            return GLib.SOURCE_CONTINUE;
        });
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
            if (this._misses) journal('[pinnedEdge.poll] menu-open -> reset');
            this._misses = 0;
            return;
        }
        if (this._dash?.hover) {
            if (this._misses) journal(`[pinnedEdge.poll] dash-hover -> reset (${this._misses})`);
            this._misses = 0;
            return;
        }

        const over = this._pointerOverDash(x, y);
        if (atEdge || over) {
            if (this._misses) journal(`[pinnedEdge.poll] reacquired (${this._misses})`);
            this._misses = 0;
            return;
        }
        if (inGrace) return;

        if (++this._misses >= MISS_LIMIT) {
            journal(`[pinnedEdge.poll] miss limit -> close (${x},${y})`);
            this._close('poll-miss');
        }
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

        // Force sizes again on show — the first render may have been
        // computed with the dash hidden, and some icon sizes resolve
        // differently once the actor is mapped.
        this._dash._forceIconSizes('show');

        this._dash.ease({
            scale_x: 1,
            opacity: 255,
            duration: OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        this._open = true;
        this._openTime = GLib.get_monotonic_time() / 1000;
        this._misses = 0;
        this._edgeSince = 0;
    }

    _close(source = '?') {
        if (!this._open) return;
        journal(`[pinnedEdge] _close source=${source}`);
        this._open = false;
        this._misses = 0;
        this._edgeSince = 0;

        if (!this._dash) return;

        // Drop the tooltip immediately — don't let it ride the close animation.
        this._dash._hideTooltip(true);

        this._dash.reactive = false;
        this._dash.remove_all_transitions();
        this._dash.ease({
            scale_x: 0,
            opacity: 0,
            duration: CLOSE_MS,
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

        if (this._pollId) { this._scope.cancel(this._pollId); this._pollId = 0; }
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