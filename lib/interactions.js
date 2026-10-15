
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import { Scope } from './scheduling.js';
import { TimeoutDelay, screenWidth, screenHeight, Display, WorkspaceManager } from './shellGlobals.js';
import { setIntent, getModelWindows } from './model.js';
import { fadeInActor } from './animationHelpers.js';
import {
    createGhostIcon, createDragActor, createClonePreview,
    getWindowApp, getWindowAppIcon, computeInsertion, evictWindowIcon,
} from './ui.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

export const DragMotionResult = DND.DragMotionResult;

// ============================================================================
// IMPERATIVE UI. Everything that connects a signal, owns a GLib source,
// mutates an actor after it was built, or takes a grab lives here.
// ============================================================================

// ==================== shared tooltip ====================
// ONE floating text bubble for the whole extension: workspace-name hint,
// window title popup, pinned-icon name, drag insertion hint. Anchored above
// or below an actor, or at a fixed Y centered under an actor. Callers never
// own it — they just call show*/hide. Lifetime is the extension's.
let _sharedTooltip = null;

class Tooltip {
    constructor() {
        this._label = new St.Label({
            style_class: 'dmenu-tooltip',
            visible: false,
            reactive: true,
            track_hover: true,
        });
        Main.layoutManager.addChrome(this._label);
    }

    get hover() { return this._label.hover; }

    showAbove(actor, text, fontSize = null) { this._show(actor, text, fontSize, 'above'); }
    showBelow(actor, text, fontSize = null) { this._show(actor, text, fontSize, 'below'); }

    showCentered(actor, text, y, fontSize = null, padding = 10) {
        this._apply(text, fontSize);
        const width = this._label.width;
        const [actorX] = actor.get_transformed_position();
        let x = actorX + (actor.get_width() - width) / 2;
        x = Math.max(padding, Math.min(x, screenWidth - width - padding));
        this._place(Math.round(x), Math.round(y));
    }

    hide() { this._label.hide(); }

    destroy() {
        Main.layoutManager.removeChrome(this._label);
        this._label.destroy();
    }

    _apply(text, fontSize) {
        if (fontSize != null) this._label.set_style(`font-size: ${fontSize}pt;`);
        this._label.set_text(text);
        this._label.show();
        try { Main.layoutManager.uiGroup.set_child_above_sibling(this._label, null); }
        catch (e) { /* nothing else in uiGroup yet */ }
    }

    _show(actor, text, fontSize, prefer) {
        this._apply(text, fontSize);

        const [width, height] = this._label.get_size();
        const [actorX, actorY] = actor.get_transformed_position();
        const actorWidth = actor.get_width();
        const actorHeight = actor.get_height();

        const monitorIndex = Main.layoutManager.findIndexForActor(actor);
        const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;
        const pad = 6;

        const minX = monitor.x + pad;
        const maxX = monitor.x + monitor.width - width - pad;
        const minY = monitor.y + pad;
        const maxY = monitor.y + monitor.height - height - pad;

        let x = Math.round(actorX + (actorWidth - width) / 2);
        x = Math.max(minX, Math.min(x, maxX));

        const above = Math.round(actorY - height - 8);
        const below = Math.round(actorY + actorHeight + 8);
        let y;
        if (prefer === 'below') { y = below; if (y > maxY) y = above; }
        else { y = above; if (y < minY) y = below; }
        y = Math.max(minY, Math.min(y, maxY));

        this._place(x, y);
    }

    _place(x, y) { this._label.set_position(x, y); }
}

export function getTooltip() {
    if (!_sharedTooltip) _sharedTooltip = new Tooltip();
    return _sharedTooltip;
}

export function destroyTooltip() {
    _sharedTooltip?.destroy();
    _sharedTooltip = null;
}

// ==================== reorder ghost ====================
/**
 * Owns the in-layout ghost for a reorder drag. One caller pattern:
 *
 *   begin(container, source)   arm / retarget
 *   update(pointerX)           reposition; returns the insertion object
 *   clear()                    tear down
 *
 * `index` counts positions among the NON-source items — the coordinate
 * system both placeWindow() and AppFavorites.moveFavoriteToPos() expect.
 */
export class ReorderGhost {
    constructor({ iconSize, giconFor = s => s._dragPayload?.gicon } = {}) {
        this._getIconSize = typeof iconSize === 'function' ? iconSize : () => iconSize;
        this._giconFor = giconFor;
        this._container = null;
        this._source = null;
        this._ghost = null;
        this._ghostIndex = null;
        this._snap = null;
    }

    get index() { return this._ghostIndex; }

    begin(container, source) {
        if (this._container !== container) {
            this._ghost?.get_parent()?.remove_child(this._ghost);
            this._ghostIndex = null;
            this._snap = null;
        }
        this._container = container;
        if (this._source !== source) { this._source = source; this._snap = null; }
    }

    update(pointerX) {
        if (!this._container || !this._source) return null;
        if (!this._snap) this._snap = this._snapshot();
        const insertion = computeInsertion(this._snap, pointerX);
        this._place(insertion);
        return insertion;
    }

    clear() {
        const ghost = this._ghost;
        this._ghost = null;
        this._ghostIndex = null;
        this._snap = null;
        this._container = null;
        this._source = null;
        if (!ghost) return;
        try { ghost.get_parent()?.remove_child(ghost); ghost.destroy(); }
        catch (e) { /* already gone */ }
    }

    _snapshot() {
        const src = this._source._actor ?? this._source;
        return this._container.get_children()
            .filter(b => b !== src && b._dragItem && b.get_stage())
            .map(b => {
                const [x] = b.get_transformed_position();
                const [w] = b.get_transformed_size();
                return { item: b, x, width: w, mid: x + w / 2, right: x + w };
            });
    }

    _place(insertion) {
        if (this._ghostIndex === insertion.index && this._ghost?.get_parent()) return;

        if (!this._ghost)
            this._ghost = createGhostIcon(this._giconFor(this._source), this._getIconSize());

        this._ghost.get_parent()?.remove_child(this._ghost);

        const { neighbor, insertBefore } = insertion;
        if (!neighbor) this._container.add_child(this._ghost);
        else if (insertBefore) this._container.insert_child_below(this._ghost, neighbor);
        else this._container.insert_child_above(this._ghost, neighbor);

        this._ghostIndex = insertion.index;
    }
}

// ==================== draggable ====================
/**
 * The ONE way to make an actor a drag source. Uniformly:
 *   - tags the actor with `_dragItem` + `_dragPayload`
 *   - installs `_delegate` (Shell passes it as `source` to drop targets)
 *   - dims the source on drag-begin and restores it on drag-end
 *
 * `handlers` (optional) are extra delegate methods, e.g. handleDragOver /
 * acceptDrop for actors that are themselves drop targets (a thumbnail that
 * forwards to a strip).
 */
export function makeDraggable(actor, {
    iconSize, payload, gicon, delegate = {}, onDragBegin = null, onDragEnd = null,
}) {
    actor._dragItem = true;
    actor._dragPayload = payload;
    actor._delegate = Object.assign(delegate, {
        _dragPayload: payload,
        _actor: actor,
        getDragActorSource: () => actor,
        getDragActor: () => createDragActor(gicon ?? payload?.gicon, iconSize),
    });

    const draggable = DND.makeDraggable(actor, {
        restoreOnSuccess: false,
        dragActorMaxSize: iconSize,
        dragActorOpacity: 178,
    });
    draggable.connect('drag-begin', () => { actor.opacity = 80; onDragBegin?.(); });
    draggable.connect('drag-end', () => {
        try { actor.opacity = 255; } catch (e) { /* source may be gone */ }
        onDragEnd?.();
    });
    return draggable;
}

// ==================== drop strip ====================
/**
 * The ONE drop target for reorder strips. The caller supplies semantics:
 *   acceptSource(source) -> bool
 *   onDrop(source, index, dragActor)
 *   onDragOver(source)              (any source)
 *   onExternalDragOver(source)      (source isn't ours)
 *   hint: { show(anchor, text), hide() } | null
 *   hintText(insertion) -> string
 */
export class DropStrip {
    constructor({
        container, ghost, acceptSource,
        externalResult = DragMotionResult.MOVE_DROP,
        onDragOver = null, onExternalDragOver = null, onDrop,
        hint = null, hintText = null,
    }) {
        Object.assign(this, {
            _container: container, _ghost: ghost, _acceptSource: acceptSource,
            _externalResult: externalResult, _onDragOver: onDragOver,
            _onExternalDragOver: onExternalDragOver, _onDrop: onDrop,
            _hint: hint, _hintText: hintText,
        });
    }

    handleDragOver(source) {
        this._onDragOver?.(source);

        if (!this._acceptSource(source)) {
            this.cancel();
            this._onExternalDragOver?.(source);
            return this._externalResult;
        }

        const [pointerX] = global.get_pointer();
        this._ghost.begin(this._container, source);
        const insertion = this._ghost.update(pointerX);
        if (insertion && this._hint && this._hintText)
            this._hint.show(insertion.neighbor ?? this._container, this._hintText(insertion));
        return DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, actor) {
        const accepted = this._acceptSource(source);
        const index = accepted ? this._ghost.index : null;
        this.cancel();
        return this._onDrop(source, index, actor);
    }

    delegate() {
        return {
            handleDragOver: s => this.handleDragOver(s),
            acceptDrop: (s, a) => this.acceptDrop(s, a),
        };
    }

    cancel() {
        this._ghost.clear();
        this._hint?.hide();
    }
}

// ==================== context menu ====================
let _activeMenu = null;

export function closeActiveMenu() { _activeMenu?.close(); }

export function openContextMenu(anchor, populate, { translationY = 0 } = {}) {
    closeActiveMenu();
    const menu = new PopupMenu.PopupMenu(anchor, 0.0, St.Side.TOP);
    new PopupMenu.PopupMenuManager(anchor).addMenu(menu);
    Main.uiGroup.add_child(menu.actor);
    populate(menu);

    _activeMenu = menu;
    menu.connect('open-state-changed', (m, isOpen) => {
        if (isOpen) return;
        if (_activeMenu === menu) _activeMenu = null;
        setIntent({ menuOpen: false });
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { menu.destroy(); return GLib.SOURCE_REMOVE; });
    });
    setIntent({ menuOpen: true });
    menu.open(true);
    if (menu._boxPointer && translationY) menu._boxPointer.translation_y = translationY;
    return menu;
}

// ==================== active hover ====================
// Only one window icon can be showing its preview / popup at a time. Both
// the clone preview and the title tooltip go through this registry.
class ActiveHover {
    static current = null;
    static ctrlPressed = false;
    static _pollId = 0;

    static activate(controller) {
        if (this.current && this.current !== controller) this.current.forceHide();
        this.current = controller;
        this._startPoll();
    }

    static deactivate(controller) {
        if (this.current === controller) {
            this.current = null;
            this._stopPoll();
        }
    }

    static _startPoll() {
        if (this._pollId) return;
        this.ctrlPressed = this._readCtrl();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
            if (!this.current) { this._pollId = 0; return GLib.SOURCE_REMOVE; }
            const ctrl = this._readCtrl();
            if (ctrl !== this.ctrlPressed) {
                this.ctrlPressed = ctrl;
                this.current.onCtrlChanged(ctrl);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    static _stopPoll() {
        if (this._pollId) { GLib.Source.remove(this._pollId); this._pollId = 0; }
    }

    static _readCtrl() {
        const [, , mods] = global.get_pointer();
        return (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
    }
}

// ==================== external drag auto-activate ====================
class ExternalDragAutoActivate {
    constructor(window) {
        this._window = window;
        this._scope = new Scope();
        this._id = 0;
        this._lastHover = 0;
    }

    notify() {
        this._lastHover = GLib.get_monotonic_time();
        if (this._id) return;
        this._id = this._scope.timeout(400, () => {
            this._id = 0;
            if ((GLib.get_monotonic_time() - this._lastHover) / 1000 > 500)
                return GLib.SOURCE_REMOVE;
            const win = this._window;
            if (win.minimized) win.unminimize();
            win.get_workspace().activate_with_focus(win, global.get_current_time());
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() { this._scope.dispose(); }
}

// ==================== window icon controller ====================
/**
 * Everything imperative about one window icon: drag source, hover preview
 * / title popup, clicks, context menu, external drag auto-activate, focus
 * highlight, and icon geometry. Rebuilt every render; the render destroys
 * it via destroy().
 */
export class WindowIconController {
    static DEBOUNCE = 30;

    constructor({ window, actor, icon, settings, strip, onRequestRender }) {
        this.window = window;
        this.actor = actor;

        this._settings = settings;
        this._strip = strip;
        this._onRequestRender = onRequestRender;
        this._scope = new Scope();
        this._external = new ExternalDragAutoActivate(window);

        this._preview = null;
        this._showingTitle = false;
        this._hoverId = 0;
        this._cleanupId = 0;

        const iconSize = settings.get_int('icon-size');

        // Icon geometry (window menus / shell thumbnails) — reconnect on
        // every parenting, one shot.
        this._scope.connect(icon, 'stage-views-changed', () => {
            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = icon.get_transformed_position();
            [rect.width, rect.height] = icon.get_transformed_size();
            window.set_icon_geometry(rect);
        });

        this._scope.connect(window, 'notify::wm-class', onRequestRender);
        this._scope.connect(window, 'notify::mapped', onRequestRender);
        this._scope.connect(window, 'notify::appears-focused', () => this._syncFocus());

        // DRAG must be wired BEFORE our own button handlers — DND's press
        // handler has to run before ours returns EVENT_STOP on a primary press,
        // or the drag never starts.
        makeDraggable(actor, {
            iconSize,
            payload: { kind: 'window', window, gicon: getWindowAppIcon(window) },
            delegate: {
                handleDragOver: (source) => {
                    if (source === actor._delegate) return DragMotionResult.CONTINUE;
                    if (!source?._dragPayload?.window) this._external.notify();
                    return strip.handleDragOver(source);
                },
                acceptDrop: (source, dragActor) => strip.acceptDrop(source, dragActor),
            },
            onDragBegin: () => setIntent({ drag: { window, sourceIcon: actor, target: null } }),
            onDragEnd: () => setIntent({ drag: null, hintWs: null }),
        });

        // Now our own handlers.
        this._scope.connect(actor, 'notify::hover', () => this._onHover());
        this._scope.connect(actor, 'button-press-event', (a, e) => this._onPressed(e));
        this._scope.connect(actor, 'button-release-event', (a, e) => this._onReleased(e));

        this._syncFocus();
    }

    destroy() {
        this.forceHide();
        this._external.destroy();
        this._scope.dispose();
        this._strip = null;
        this._onRequestRender = null;
        evictWindowIcon(this.window);
    }

    // ---- hover ----
    _onHover() {
        if (this._hoverId) { this._scope.cancel(this._hoverId); this._hoverId = 0; }
        if (this.actor.hover) {
            this._cancelCleanup();
            if (this._isShowing()) { this.onCtrlChanged(ActiveHover.ctrlPressed); return; }
            this._hoverId = this._scope.timeout(WindowIconController.DEBOUNCE, () => {
                this._hoverId = 0;
                if (!this.actor.hover && !this._isShowing()) return GLib.SOURCE_REMOVE;
                ActiveHover.activate(this);
                this._render();
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._isShowing()) {
            this._startCleanup();
        }
    }

    onCtrlChanged(ctrl) { this._render(ctrl); }

    /** Called by ActiveHover when another icon wants the slot. */
    forceHide() {
        if (this._hoverId) { this._scope.cancel(this._hoverId); this._hoverId = 0; }
        this._cancelCleanup();
        this._hide();
        ActiveHover.deactivate(this);
    }

    _render(ctrl = ActiveHover.ctrlPressed) {
        if (ctrl) { this._hidePreview(); this._showTitle(); }
        else { this._hideTitle(); this._showPreview(); }
    }

    _isShowing() { return this._showingTitle || !!this._preview; }

    _onPreviewHover(isHovered) {
        if (isHovered) this._cancelCleanup();
        else if (!this.actor.hover) this._startCleanup();
    }

    _startCleanup() {
        this._cancelCleanup();
        this._cleanupId = this._scope.timeout(TimeoutDelay, () => {
            this._cleanupId = 0;
            const tip = getTooltip();
            if (this.actor.hover || this._preview?.hover || (this._showingTitle && tip.hover))
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
        this._hideTitle();
    }

    _showTitle() {
        this._showingTitle = true;
        getTooltip().showCentered(
            this.actor,
            this.window.get_title() || 'Untitled Window',
            screenHeight - 200,
            this._settings.get_int('title-popup-font-size'));
    }

    _hideTitle() {
        if (!this._showingTitle) return;
        this._showingTitle = false;
        getTooltip().hide();
    }

    _showPreview() {
        if (this._preview) return;
        const win = this.window;
        const previewHeight = this._settings.get_int('hover-preview-height');
        const built = createClonePreview(win, previewHeight, {
            wrapperStyleClass: 'hover-preview-wrapper',
            showTitle: false,
            closeButtonSize: this._settings.get_int('close-button-size'),
            closeButtonOffsetX: 60,
            closeButtonOffsetY: 10,
        });
        if (!built) return;

        if (built.wrapper)
            this._scope.connect(built.wrapper, 'notify::hover',
                () => this._onPreviewHover(built.wrapper.hover));
        if (built.wrapper)
            this._scope.connect(built.wrapper, 'button-press-event', (a, e) => {
                if (e.get_button() === Clutter.BUTTON_PRIMARY) {
                    win.get_workspace().activate_with_focus(win, 0);
                    this._hide();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        if (built.closeButton)
            this._scope.connect(built.closeButton, 'clicked', () => {
                win.delete(global.get_current_time());
                this._hide();
                return Clutter.EVENT_STOP;
            });

        const [anchorX] = this.actor.get_transformed_position();
        const x = Math.max(0, anchorX + (this.actor.get_width() - built.width) / 2);
        const y = screenHeight - built.height - 200 + 55;
        built.actor.set_position(x, y);

        this._preview = built.actor;
        Main.layoutManager.addChrome(this._preview);
        fadeInActor(this._preview);
    }

    _hidePreview() {
        if (!this._preview) return;
        const actor = this._preview;
        this._preview = null;
        Main.layoutManager.removeChrome(actor);
        actor.destroy();
    }

    // ---- focus ----
    _syncFocus() {
        if (this.window.appears_focused) this.actor.add_style_class_name('focused');
        else this.actor.remove_style_class_name('focused');
    }

    // ---- clicks ----
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
        if (winWs === WorkspaceManager.get_active_workspace()) {
            if (win.minimized) { win.unminimize(); win.activate_with_workspace(0, winWs); }
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
                const others = getModelWindows(win.get_workspace())
                    .filter(w => w !== win && w.get_wm_class() === wmClass
                        && w.get_wm_class_instance() !== 'file_progress');
                const now = global.get_current_time();
                for (const w of others) w.delete(now);
            });

            const app = getWindowApp(win);
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
        }, { translationY: -35 });
    }

    _isCovered(window) {
        if (window.minimized) return false;
        const workspace = WorkspaceManager.get_active_workspace();
        const stacked = Display.sort_windows_by_stacking(
            Display.list_all_windows().filter(w =>
                !w.minimized &&
                (w.get_window_type() === Meta.WindowType.NORMAL || w.get_window_type() === Meta.WindowType.DIALOG) &&
                w.get_workspace() === workspace));

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