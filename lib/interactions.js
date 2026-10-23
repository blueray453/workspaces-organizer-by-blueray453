// ===== FILE: ./lib/interactions.js =====
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import * as Scheduling from './scheduling.js';
import * as Model from './model.js';
import * as UI from './ui.js';
import * as WorkspaceActions from './workspaceActions.js';
import * as Motion from './motion.js';
import { S, px } from './sizes.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

export const DragMotionResult = DND.DragMotionResult;

// ==================== shared tooltip ====================
const TOOLTIP_HIDE_GRACE_MS = 80;
const TOOLTIP_EDGE_PAD = 12;
const TOOLTIP_GEOMETRY_TRIES = 3;

function createTooltip() {
    const label = new St.Label({
        style_class: 'topnotch-tooltip',
        visible: false,
        reactive: false,
        track_hover: false,
    });

    try {
        Main.layoutManager.addChrome(label, {
            affectsInputRegion: false,
            trackFullscreen: false,
        });
    } catch (e) {
        journal(`[tooltip] addChrome failed: ${e.message}`);
    }

    let visible = false;
    let hideId = 0;
    let currentText = '';

    let anchor = null;
    let anchorDestroyId = 0;

    let pending = null;
    let pendingId = 0;

    function cancelHide() {
        if (hideId) { GLib.Source.remove(hideId); hideId = 0; }
    }

    function clearPending() {
        pending = null;
        if (pendingId) { GLib.Source.remove(pendingId); pendingId = 0; }
    }

    function unbindAnchor() {
        if (anchorDestroyId && anchor) {
            try { anchor.disconnect(anchorDestroyId); } catch (e) { /* gone */ }
        }
        anchor = null;
        anchorDestroyId = 0;
    }

    function bindAnchor(actor) {
        if (anchor === actor) return;
        unbindAnchor();
        anchor = actor;
        try {
            anchorDestroyId = actor.connect('destroy', () => {
                if (anchor === actor) {
                    unbindAnchor();
                    hide(true);
                }
            });
        } catch (e) {
            anchor = null;
            anchorDestroyId = 0;
        }
    }

    function applyText(text) {
        if (currentText === text) return;
        currentText = text;
        label.set_text(text);
        const ct = label.clutter_text;
        ct.set_ellipsize(Pango.EllipsizeMode.NONE);
        ct.set_line_wrap(false);
        ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        ct.set_single_line_mode(true);
    }

    function measure() {
        const [, w] = label.get_preferred_width(-1);
        const [, h] = label.get_preferred_height(w);
        return { w, h };
    }

    function monitorFor(actor) {
        let idx = -1;
        try { idx = Main.layoutManager.findIndexForActor(actor); } catch (e) { /* fallback */ }
        return Main.layoutManager.monitors[idx] ?? Main.layoutManager.primaryMonitor;
    }

    function geometryOf(actor) {
        try {
            const [ax, ay] = actor.get_transformed_position();
            const aw = actor.get_width();
            const ah = actor.get_height();
            if (![ax, ay, aw, ah].every(Number.isFinite)) return null;
            if (aw <= 0 && ah <= 0) return null;
            return { ax, ay, aw, ah };
        } catch (e) {
            return null;
        }
    }

    function clampToMonitor(x, y, w, h, monitor) {
        const pad = TOOLTIP_EDGE_PAD;
        x = Math.max(monitor.x + pad, Math.min(x, monitor.x + monitor.width - w - pad));
        y = Math.max(monitor.y + pad, Math.min(y, monitor.y + monitor.height - h - pad));
        return { x: Math.round(x), y: Math.round(y) };
    }

    function positionFor(geo, spec, w, h, monitor) {
        const { ax, ay, aw, ah } = geo;
        const { mode, gap = 8 } = spec;
        let x, y;

        if (mode === 'centered') {
            x = ax + (aw - w) / 2;
            const padding = spec.padding ?? 10;
            const clampedX = Math.max(monitor.x + padding,
                Math.min(x, monitor.x + monitor.width - w - padding));
            return { x: Math.round(clampedX), y: Math.round(spec.y) };
        }

        if (mode === 'above') {
            x = ax + (aw - w) / 2;
            y = ay - h - gap;
            if (y < monitor.y + TOOLTIP_EDGE_PAD) y = ay + ah + gap;
        } else if (mode === 'below') {
            x = ax + (aw - w) / 2;
            y = ay + ah + gap;
            if (y + h > monitor.y + monitor.height - TOOLTIP_EDGE_PAD) y = ay - h - gap;
        } else if (mode === 'right') {
            x = ax + aw + gap;
            y = ay + (ah - h) / 2;
            if (x + w > monitor.x + monitor.width - TOOLTIP_EDGE_PAD) x = ax - w - gap;
        } else {
            x = ax - w - gap;
            y = ay + (ah - h) / 2;
            if (x < monitor.x + TOOLTIP_EDGE_PAD) x = ax + aw + gap;
        }
        return clampToMonitor(x, y, w, h, monitor);
    }

    function revealAt(pos) {
        label.remove_all_transitions();
        label.set_position(pos.x, pos.y);
        label.show();
        Motion.fadeIn(label, { duration: 'tooltipFade' });
        visible = true;
        try { Main.layoutManager.uiGroup.set_child_above_sibling(label, null); }
        catch (e) { /* uiGroup not fully built yet */ }
    }

    function glideTo(pos) {
        Motion.glide(label, pos.x, pos.y, { duration: 'tooltipGlide' });
    }

    function doShow() {
        const req = pending;
        pending = null;
        if (!req) return;

        const geo = geometryOf(req.actor);
        if (!geo) {
            if (req.tries < TOOLTIP_GEOMETRY_TRIES) {
                pending = { ...req, tries: req.tries + 1 };
                if (!pendingId) {
                    pendingId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        pendingId = 0;
                        if (pending) doShow();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
            return;
        }

        const { w, h } = measure();
        const monitor = monitorFor(req.actor);
        const pos = positionFor(geo, req.spec, w, h, monitor);
        bindAnchor(req.actor);

        if (visible) glideTo(pos);
        else revealAt(pos);
    }

    function show(actor, text, spec) {
        if (!actor) return;
        cancelHide();
        applyText(text);
        pending = { actor, spec, tries: 0 };
        doShow();
    }

    function hide(instant = false) {
        clearPending();

        if (instant) {
            cancelHide();
            unbindAnchor();
            if (!visible) return;
            label.remove_all_transitions();
            label.hide();
            label.opacity = 0;
            visible = false;
            return;
        }

        if (!visible || hideId) return;
        hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_HIDE_GRACE_MS, () => {
            hideId = 0;
            if (!visible) return GLib.SOURCE_REMOVE;
            unbindAnchor();
            visible = false;
            Motion.fadeOut(label, {
                duration: 'tooltipFade',
                onComplete: () => { if (!visible) label.hide(); },
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    return {
        get hover() { return label.hover; },

        showAbove(actor, text) { show(actor, text, { mode: 'above' }); },
        showBelow(actor, text) { show(actor, text, { mode: 'below' }); },
        showRight(actor, text, gap = 8) { show(actor, text, { mode: 'right', gap }); },
        showLeft(actor, text, gap = 8) { show(actor, text, { mode: 'left', gap }); },
        showCentered(actor, text, y, padding = 10) {
            show(actor, text, { mode: 'centered', y, padding });
        },

        hide,
        hideNow() { hide(true); },

        destroy() {
            clearPending();
            cancelHide();
            unbindAnchor();
            try { Main.layoutManager.removeChrome(label); } catch (e) { /* gone */ }
            try { label.destroy(); } catch (e) { /* gone */ }
            visible = false;
            currentText = '';
        },
    };
}

let _sharedTooltip = null;

export function getTooltip() {
    if (!_sharedTooltip) _sharedTooltip = createTooltip();
    return _sharedTooltip;
}

export function destroyTooltip() {
    _sharedTooltip?.destroy();
    _sharedTooltip = null;
}

// ==================== reorder bar ====================
// One insertion bar for every reorderable strip. Nothing in the layout moves.
export function createReorderBar({
    axis = 'x',
    isTarget = b => b._dragItem || b._groupWindows,
    sourceItem = s => s?._actor ?? s,
    items = null,
    viewport = null,
} = {}) {
    const vert = axis === 'y';
    const T = px(0.15);
    const PAD = 8;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    let container = null, source = null, bar = null;
    let snap = null, last = null;

    function takeSnapshot() {
        const src = sourceItem(source);
        const all = (items ? items() : container.get_children())
            .filter(b => isTarget(b) && b.get_stage());
        const rects = all.filter(b => b !== src).map(b => {
            const [x, y] = b.get_transformed_position();
            const [w, h] = b.get_transformed_size();
            const start = vert ? y : x, size = vert ? h : w;
            return {
                item: b, start, end: start + size, mid: start + size / 2,
                cross: vert ? x : y, crossSize: vert ? w : h,
            };
        });
        return { rects, srcAt: all.indexOf(src) };
    }

    function ensureBar() {
        if (bar) return bar;
        bar = new St.Widget({ style_class: 'reorder-bar', reactive: false, visible: false });
        Main.layoutManager.addTopChrome(bar,
            { affectsInputRegion: false, trackFullscreen: false });
        return bar;
    }

    function hide() { bar?.hide(); }

    function place(ins) {
        const { rects } = snap;
        const n = rects.length, k = ins.index;
        let pos;
        if (k === 0) pos = rects[0].start - T;
        else if (k === n) pos = rects[n - 1].end + T;
        else pos = (rects[k - 1].end + rects[k].start) / 2;

        const v = viewport?.();
        if (v?.get_stage()) {
            const [vx, vy] = v.get_transformed_position();
            const [vw, vh] = v.get_transformed_size();
            const lo = vert ? vy : vx;
            pos = clamp(pos, lo + T / 2, lo + (vert ? vh : vw) - T / 2);
        }

        const ref = rects[Math.min(k, n - 1)];
        const b = ensureBar();
        const len = Math.round(ref.crossSize + PAD * 2);
        const cross = Math.round(ref.cross - PAD);
        const along = Math.round(pos - T / 2);
        if (vert) { b.set_size(len, T); b.set_position(cross, along); }
        else { b.set_size(T, len); b.set_position(along, cross); }

        if (!b.visible) {
            b.show();
            try { Main.layoutManager.uiGroup.set_child_above_sibling(b, null); }
            catch (e) { /* uiGroup not ready */ }
        }
    }

    function begin(newContainer, newSource) {
        if (container !== newContainer || source !== newSource) {
            snap = null; last = null; hide();
        }
        container = newContainer;
        source = newSource;
    }

    function update(pointer) {
        if (!container || !source) return null;
        snap ??= takeSnapshot();
        const ins = UI.computeInsertion(snap.rects, pointer);
        last = ins;
        const noop = snap.srcAt >= 0 && ins.index === snap.srcAt;
        if (noop || snap.rects.length === 0) hide();
        else place(ins);
        return ins;
    }

    function clear() {
        hide();
        container = null; source = null; snap = null; last = null;
    }

    function destroy() {
        clear();
        if (!bar) return;
        try { Main.layoutManager.removeChrome(bar); } catch (e) { /* gone */ }
        try { bar.destroy(); } catch (e) { /* gone */ }
        bar = null;
    }

    return {
        get index() { return last ? last.index : null; },
        get insertion() {
            return last ? { neighbor: last.neighbor, insertBefore: last.insertBefore } : null;
        },
        begin, update, clear, destroy,
    };
}

// ==================== draggable ====================
export function makeDraggable(actor, {
    iconSize, payload, gicon, delegate = {}, onDragBegin = null, onDragEnd = null,
}) {
    actor._dragItem = true;
    actor._dragPayload = payload;
    actor._delegate = Object.assign(delegate, {
        _dragPayload: payload,
        _actor: actor,
        getDragActorSource: () => actor,
        getDragActor: () => UI.createDragActor(gicon ?? payload?.gicon, iconSize),
    });

    const draggable = DND.makeDraggable(actor, {
        restoreOnSuccess: false,
        dragActorMaxSize: iconSize,
        dragActorOpacity: 178,
    });
    draggable.connect('drag-begin', () => { actor.opacity = 80; onDragBegin?.(); });
    // Restores the plain full opacity on drag end (no derived state to sync).
    draggable.connect('drag-end', () => {
        try { actor.opacity = 255; } catch (e) { /* source may be gone */ }
        onDragEnd?.();
    });
    return draggable;
}

// ==================== drop strip ====================
export function createDropStrip({
    container, reorder, acceptSource,
    externalResult = DragMotionResult.MOVE_DROP,
    onDragOver = null, onExternalDragOver = null, onDrop,
    hint = null, hintText = null,
}) {
    function handleDragOver(src) {
        onDragOver?.(src);

        if (!acceptSource(src)) {
            cancel();
            onExternalDragOver?.(src);
            return externalResult;
        }

        const [pointerX] = global.get_pointer();
        reorder.begin(container, src);
        const insertion = reorder.update(pointerX);
        if (insertion && hint && hintText)
            hint.show(insertion.neighbor ?? container, hintText(insertion));
        return DragMotionResult.MOVE_DROP;
    }

    function acceptDrop(src, actor) {
        const accepted = acceptSource(src);
        const index = accepted ? reorder.index : null;
        const insertion = accepted ? reorder.insertion : null;
        cancel();
        return onDrop(src, index, actor, insertion);
    }

    function cancel() {
        reorder.clear();
        hint?.hide();
    }

    function delegate() {
        return {
            handleDragOver: s => handleDragOver(s),
            acceptDrop: (s, a) => acceptDrop(s, a),
        };
    }

    return { handleDragOver, acceptDrop, delegate, cancel };
}

// ==================== context menu ====================
let _activeMenu = null;

export function openContextMenu(anchor, populate, { translationY = 0, onStateChange = null } = {}) {
    _activeMenu?.close();
    const menu = new PopupMenu.PopupMenu(anchor, 0.0, St.Side.TOP);
    const manager = new PopupMenu.PopupMenuManager(anchor);
    manager.addMenu(menu);
    Main.uiGroup.add_child(menu.actor);
    populate(menu);

    _activeMenu = menu;
    menu.connect('open-state-changed', (m, isOpen) => {
        if (isOpen) return;
        if (_activeMenu === menu) _activeMenu = null;
        onStateChange?.(false);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try { manager.destroy(); } catch (e) { /* already gone */ }
            menu.destroy();
            return GLib.SOURCE_REMOVE;
        });
    });
    onStateChange?.(true);
    menu.open(true);
    if (menu._boxPointer && translationY) menu._boxPointer.translation_y = translationY;
    return menu;
}

// ==================== active hover ====================
const ActiveHover = (() => {
    let current = null;
    let ctrlPressed = false;
    let pollId = 0;

    function readCtrl() {
        const [, , mods] = global.get_pointer();
        return (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
    }

    function stopPoll() {
        if (pollId) { GLib.Source.remove(pollId); pollId = 0; }
    }

    function startPoll() {
        if (pollId) return;
        ctrlPressed = readCtrl();
        pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Model.TimeoutDelay, () => {
            if (!current) { pollId = 0; return GLib.SOURCE_REMOVE; }
            const ctrl = readCtrl();
            if (ctrl !== ctrlPressed) {
                ctrlPressed = ctrl;
                current.onCtrlChanged(ctrl);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    return {
        get current() { return current; },
        get ctrlPressed() { return ctrlPressed; },
        activate(controller) {
            if (current && current !== controller) current.forceHide(true);
            current = controller;
            startPoll();
        },
        deactivate(controller) {
            if (current === controller) { current = null; stopPoll(); }
        },
    };
})();

// ==================== external drag auto-activate ====================
const EXT_HOVER_FRESH_MS = 120;

function createExternalDragAutoActivate(onFire) {
    const scope = new Scheduling.Scope();
    let id = 0;
    let lastHover = 0;

    function notify() {
        lastHover = GLib.get_monotonic_time();
        if (id) return;
        id = scope.timeout(400, () => {
            id = 0;
            if ((GLib.get_monotonic_time() - lastHover) / 1000 > EXT_HOVER_FRESH_MS)
                return GLib.SOURCE_REMOVE;
            onFire();
            return GLib.SOURCE_REMOVE;
        });
    }

    function destroy() { scope.dispose(); }

    return { notify, destroy };
}

// ==================== window icon controller ====================
export class WindowIconController {
    static DEBOUNCE = 30;

    constructor({ window, actor, icon, settings, strip, onRequestRender,
        onHoverFlyout, onHoverExit }) {
        this.window = window;
        this.actor = actor;

        this._settings = settings;
        this._strip = strip;
        this._onRequestRender = onRequestRender;
        this._onHoverFlyout = onHoverFlyout;
        this._onHoverExit = onHoverExit;
        this._scope = new Scheduling.Scope();
        this._external = createExternalDragAutoActivate(
            () => WorkspaceActions.focusWindow(window));

        this._preview = null;
        this._previewScope = null;
        this._hoverId = 0;
        this._cleanupId = 0;

        const iconSize = S.indicator.windowIcon;

        this._scope.connect(icon, 'stage-views-changed', () => {
            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = icon.get_transformed_position();
            [rect.width, rect.height] = icon.get_transformed_size();
            window.set_icon_geometry(rect);
        });

        this._scope.connect(window, 'notify::wm-class', onRequestRender);
        this._scope.connect(window, 'notify::mapped', onRequestRender);

        makeDraggable(actor, {
            iconSize,
            payload: { kind: 'window', window, gicon: UI.getWindowAppIcon(window) },
            delegate: {
                handleDragOver: (source) => {
                    if (source === actor._delegate) return DragMotionResult.CONTINUE;
                    if (!source?._dragPayload?.window) this._external.notify();
                    return this._strip?.handleDragOver(source) ?? DragMotionResult.CONTINUE;
                },
                acceptDrop: (source, dragActor) =>
                    this._strip?.acceptDrop(source, dragActor) ?? false,
            },
            onDragBegin: () => Model.setIntent({ drag: true }),
            onDragEnd: () => Model.setIntent({ drag: null, hintWs: null }),
        });

        this._scope.connect(actor, 'notify::hover', () => this._onHover());
        this._scope.connect(actor, 'button-press-event', (a, e) => this._onPressed(e));
        this._scope.connect(actor, 'button-release-event', (a, e) => this._onReleased(e));
    }

    setStrip(strip) { this._strip = strip; }

    notifyExternalDrag() { this._external.notify(); }

    destroy() {
        this.forceHide();
        this._external.destroy();
        this._scope.dispose();
        this._strip = null;
        this._onRequestRender = null;
        this._onHoverFlyout = null;
        this._onHoverExit = null;
        try { this.actor?.destroy(); } catch (e) { /* already gone */ }
    }

    _onHover() {
        if (this._hoverId) { this._scope.cancel(this._hoverId); this._hoverId = 0; }
        if (this.actor.hover) {
            this._cancelCleanup();
            if (this._preview) return;
            this._hoverId = this._scope.timeout(WindowIconController.DEBOUNCE, () => {
                this._hoverId = 0;
                if (!this.actor.hover && !this._preview) return GLib.SOURCE_REMOVE;
                ActiveHover.activate(this);
                this._render();
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._preview) {
            this._startCleanup();
        }
    }

    onCtrlChanged(ctrl) {
        if (!this.actor.hover && !this._preview) return;
        this._render(ctrl);
    }

    forceHide(keepFlyout = false) {
        if (this._hoverId) { this._scope.cancel(this._hoverId); this._hoverId = 0; }
        this._cancelCleanup();
        if (keepFlyout) this._hidePreview();
        else this._hide();
        ActiveHover.deactivate(this);
    }

    _render(ctrl = ActiveHover.ctrlPressed) {
        if (ctrl) {
            this._hideFlyout();
            this._showPreview();
        } else {
            this._hidePreview();
            this._showFlyout();
        }
    }

    _showFlyout() {
        if (!this._onHoverFlyout) return;
        const ws = this.window.get_workspace();
        const wsIndex = ws ? ws.index()
            : Model.WorkspaceManager.get_active_workspace_index();
        this._onHoverFlyout(this.actor, wsIndex, this.window);
    }

    _hideFlyout() { this._onHoverExit?.(); }

    _onPreviewHover(isHovered) {
        if (isHovered) this._cancelCleanup();
        else if (!this.actor.hover) this._startCleanup();
    }

    _startCleanup() {
        this._cancelCleanup();
        this._cleanupId = this._scope.timeout(Model.TimeoutDelay, () => {
            this._cleanupId = 0;
            if (this.actor.hover || this._preview?.hover)
                return GLib.SOURCE_REMOVE;
            this._hide();
            ActiveHover.deactivate(this);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelCleanup() {
        if (this._cleanupId) { this._scope.cancel(this._cleanupId); this._cleanupId = 0; }
    }

    _hide() {
        this._hidePreview();
        this._hideFlyout();
    }

    _showPreview() {
        if (this._preview) return;
        const win = this.window;
        const previewHeight = S.indicator.previewHeight;
        const built = UI.createClonePreview(win, previewHeight, {
            wrapperStyleClass: 'hover-preview-wrapper',
            showTitle: false,
            closeButtonSize: S.indicator.closeButton,
            closeButtonOffsetX: S.indicator.closeOffsetX,
            closeButtonOffsetY: S.indicator.closeOffsetY,
        });
        if (!built) return;

        this._previewScope = new Scheduling.Scope();

        if (built.wrapper)
            this._previewScope.connect(built.wrapper, 'notify::hover',
                () => this._onPreviewHover(built.wrapper.hover));
        if (built.wrapper)
            this._previewScope.connect(built.wrapper, 'button-press-event', (a, e) => {
                if (e.get_button() === Clutter.BUTTON_PRIMARY) {
                    win.get_workspace().activate_with_focus(win, 0);
                    this._hide();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        if (built.closeButton)
            this._previewScope.connect(built.closeButton, 'clicked', () => {
                win.delete(global.get_current_time());
                this._hide();
                return Clutter.EVENT_STOP;
            });

        const [anchorX] = this.actor.get_transformed_position();
        const monitorIndex = Main.layoutManager.findIndexForActor(this.actor);
        const monitor = Main.layoutManager.monitors[monitorIndex]
            ?? Main.layoutManager.primaryMonitor;
        const x = Math.max(monitor.x,
            anchorX + (this.actor.get_width() - built.width) / 2);
        const clampedX = Math.min(x, monitor.x + monitor.width - built.width);
        const y = monitor.y + monitor.height - built.height - 200 + 55;
        built.actor.set_position(Math.round(clampedX), Math.round(y));

        this._preview = built.actor;
        Main.layoutManager.addChrome(this._preview);
        Motion.fadeIn(this._preview);
    }

    _hidePreview() {
        if (!this._preview) return;
        this._previewScope?.dispose();
        this._previewScope = null;
        const actor = this._preview;
        this._preview = null;
        Main.layoutManager.removeChrome(actor);
        actor.destroy();
    }

    _onPressed(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this.forceHide();
            this._openMenu();
            return Clutter.EVENT_STOP;
        }
        return button === Clutter.BUTTON_PRIMARY ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _onReleased(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;

        this.forceHide();
        const win = this.window;
        const winWs = win.get_workspace();
        if (winWs === Model.WorkspaceManager.get_active_workspace()) {
            if (win.minimized) { WorkspaceActions.focusWindow(win); }
            else if (!win.appears_focused || this._isCovered(win)) win.activate_with_workspace(0, winWs);
            else win.minimize();
        } else {
            winWs.activate_with_focus(win, 0);
        }
        return Clutter.EVENT_STOP;
    }

    _openMenu() {
        const win = this.window;
        openContextMenu(this.actor, m => {
            m.addAction(`Activate ${win.title}`, () => win.get_workspace().activate_with_focus(win, 0));
            m.addAction(`Close ${win.title}`, () => win.delete(0));
            m.addAction(`Close Except ${win.title}`, () => {
                const wmClass = win.get_wm_class();
                const others = Model.getModelWindows(win.get_workspace())
                    .filter(w => w !== win && w.get_wm_class() === wmClass
                        && w.get_wm_class_instance() !== 'file_progress');
                const now = global.get_current_time();
                for (const w of others) w.delete(now);
            });

            const app = UI.getWindowApp(win);
            if (!app) return;
            m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const favorites = AppFavorites.getAppFavorites();
            const isFav = favorites.isFavorite(app.get_id());
            m.addAction(isFav ? `Unpin ${app.get_name()}` : `Pin ${app.get_name()}`, () => {
                if (isFav) favorites.removeFavorite(app.get_id());
                else favorites.addFavorite(app.get_id());
            });

            const appInfo = app.get_app_info();
            const actions = appInfo?.list_actions();
            if (actions?.length) {
                m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                for (const action of actions)
                    m.addAction(`${appInfo.get_action_name(action)}`, () => app.launch_action(action, 0, -1));
            }
        }, { translationY: -35, onStateChange: Model.menuIntent });
    }

    _isCovered(window) {
        if (window.minimized) return false;
        const workspace = Model.WorkspaceManager.get_active_workspace();
        const stacked = Model.Display.sort_windows_by_stacking(
            Model.getModelWindows(workspace).filter(w => !w.minimized));

        const index = stacked.indexOf(window);
        if (index === -1) return false;

        const area = workspace.get_work_area_for_monitor(window.get_monitor());
        const clip = r => ({
            l: Math.max(r.x, area.x), t: Math.max(r.y, area.y),
            r: Math.min(r.x + r.width, area.x + area.width),
            b: Math.min(r.y + r.height, area.y + area.height),
        });

        const t = clip(window.get_frame_rect());
        if (t.r <= t.l || t.b <= t.t) return false;

        for (let i = index + 1; i < stacked.length; i++) {
            const other = stacked[i];
            if (other.get_transient_for() === window) continue;
            const o = clip(other.get_frame_rect());
            if (o.r <= o.l || o.b <= o.t) continue;
            if (t.l < o.r && t.r > o.l && t.t < o.b && t.b > o.t) return true;
        }
        return false;
    }
}