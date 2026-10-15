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
import { setIntent } from './model.js';
import { fadeInActor } from './animationHelpers.js';
import {
    buildTooltipLabel, buildGhostIcon, buildDragActor, buildClonePreview, getWindowApp, getWindowAppIcon,
} from './ui.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

export const DragMotionResult = DND.DragMotionResult;

// ============================================================================
// IMPERATIVE UI
//
// Everything that connects a signal, owns a GLib source, mutates an actor
// after it was built, or takes a grab lives here. These controllers are
// element-agnostic: the indicator and both overlays drive the same ones.
// Each owns a Scope and tears itself down with destroy().
// ============================================================================

// ==================== insertion math ====================
// rects: [{ item, x, mid, right }] in left-to-right order.
export function computeInsertion(rects, pointerX) {
    if (rects.length === 0)
        return { index: 0, neighbor: null, insertBefore: true };

    const first = rects[0];
    const last = rects[rects.length - 1];
    let target = last, before = false;

    if (pointerX < first.x) {
        target = first; before = true;
    } else if (pointerX < last.right) {
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i], next = rects[i + 1];
            if (pointerX >= r.x && pointerX < r.right) {
                target = r; before = pointerX < r.mid; break;
            }
            if (next && pointerX >= r.right && pointerX <= next.x) {
                before = (pointerX - r.right) > (next.x - pointerX);
                target = before ? next : r;
                break;
            }
        }
    }

    const i = rects.indexOf(target);
    return { index: before ? i : i + 1, neighbor: target.item, insertBefore: before };
}

// ==================== reorder ghost ====================
/**
 * Owns the in-layout ghost for a reorder drag. Shared by the indicator icon
 * strips and the pinned bar. Both drive it exactly the same way:
 *
 *   begin(container, source)   arm / retarget (safe to call every motion)
 *   update(pointerX)           reposition; returns the insertion object
 *   clear()                    tear down and forget
 *
 * `source` is the drag delegate. The index it reports counts positions among
 * the NON-source items — the coordinate system both placeWindow() and
 * AppFavorites.moveFavoriteToPos() expect.
 */
export class ReorderGhostController {
    constructor({ iconSize, giconFor = s => s._dragPayload?.gicon }) {
        this._getIconSize = typeof iconSize === 'function' ? iconSize : () => iconSize;
        this._giconFor = giconFor;

        this._container = null;
        this._source = null;
        this._ghost = null;
        this._ghostIndex = null;
        this._snap = null;
        this._insertion = null;
    }

    get index() { return this._ghostIndex; }
    get insertion() { return this._insertion; }

    begin(container, source) {
        if (this._container !== container) {
            this._ghost?.get_parent()?.remove_child(this._ghost);
            this._ghostIndex = null;
            this._snap = null;
        }
        this._container = container;
        if (this._source !== source) {
            this._source = source;
            this._snap = null;
        }
    }

    update(pointerX) {
        if (!this._container || !this._source) return null;
        if (!this._snap) this._snap = this._buildSnapshot();
        const insertion = computeInsertion(this._snap, pointerX);
        this._insertion = insertion;
        this._positionGhost(insertion);
        return insertion;
    }

    clear() {
        const ghost = this._ghost;
        this._ghost = null;
        this._ghostIndex = null;
        this._snap = null;
        this._insertion = null;
        this._container = null;
        this._source = null;
        if (!ghost) return;
        try {
            ghost.get_parent()?.remove_child(ghost);
            ghost.destroy();
        } catch (e) { /* already destroyed */ }
    }

    _buildSnapshot() {
        const srcActor = this._source._actor ?? this._source;
        return this._container.get_children()
            .filter(b => b !== srcActor && b._dragItem && b.get_stage())
            .map(b => {
                const [x] = b.get_transformed_position();
                const [width] = b.get_transformed_size();
                return { item: b, x, width, mid: x + width / 2, right: x + width };
            });
    }

    _positionGhost(insertion) {
        if (this._ghostIndex === insertion.index && this._ghost?.get_parent()) return;

        if (!this._ghost)
            this._ghost = buildGhostIcon(this._giconFor(this._source), this._getIconSize());

        this._ghost.get_parent()?.remove_child(this._ghost);

        // Anchor to a neighbor (still in the container) rather than a raw
        // index — the source is still in the child list.
        const { neighbor, insertBefore } = insertion;
        if (!neighbor) this._container.add_child(this._ghost);
        else if (insertBefore) this._container.insert_child_below(this._ghost, neighbor);
        else this._container.insert_child_above(this._ghost, neighbor);

        this._ghostIndex = insertion.index;
    }
}

// ==================== drag source ====================
/**
 * The ONE way to make an actor draggable — window icons, pinned icons and
 * overlay result rows all use it. It uniformly:
 *   - tags the actor with `_dragItem` + `_dragPayload` (how drop targets and
 *     the ghost identify and render it)
 *   - sets `_delegate` (Shell passes it as `source` to drop targets)
 *   - dims the source on drag-begin and restores it on drag-end
 *
 * Drag-specific model side effects (e.g. suspending renders) go in the
 * onDragBegin / onDragEnd callbacks.
 */
export function makeDraggable(actor, {
    iconSize, payload, getDragActor = null, hooks = {}, onDragBegin = null, onDragEnd = null,
}) {
    actor._dragItem = true;
    actor._dragPayload = payload;
    actor._delegate = {
        ...hooks,
        _dragPayload: payload,
        _actor: actor,
        getDragActorSource: () => actor,
        ...(getDragActor ? { getDragActor } : {}),
    };

    const draggable = DND.makeDraggable(actor, {
        restoreOnSuccess: false,
        dragActorMaxSize: iconSize,
        dragActorOpacity: 178,
    });

    draggable.connect('drag-begin', () => {
        actor.opacity = 80;
        onDragBegin?.();
    });
    draggable.connect('drag-end', () => {
        try { actor.opacity = 255; } catch (e) { /* source may be gone */ }
        onDragEnd?.();
    });
    return draggable;
}

// ==================== drop strip ====================
/**
 * The ONE drop target. It owns the ghost update, the optional insertion hint,
 * and the external-drag side effect; the caller supplies the semantics.
 *
 *   acceptSource(source) -> bool   is this a reorder of ours? (drives the ghost)
 *   onDragOver(source)             fired on every motion (before ghost update)
 *   onDrop(source, index, actor)   index is null when not an accepted reorder
 */
export class DropStrip {
    constructor({
        container, ghost, acceptSource, externalResult = DragMotionResult.MOVE_DROP,
        tooltip = null, hintText = null, onDragOver = null, onDrop,
    }) {
        this._container = container;
        this._ghost = ghost;
        this._acceptSource = acceptSource;
        this._externalResult = externalResult;
        this._tooltip = tooltip;
        this._hintText = hintText;
        this._onDragOver = onDragOver;
        this._onDrop = onDrop;
    }

    handleDragOver(source) {
        this._onDragOver?.(source);

        if (!this._acceptSource(source)) {
            this.cancel();
            return this._externalResult;
        }

        const [pointerX] = global.get_pointer();
        this._ghost.begin(this._container, source);
        const insertion = this._ghost.update(pointerX);
        if (insertion && this._tooltip && this._hintText)
            this._tooltip.showAbove(insertion.neighbor ?? this._container, this._hintText(insertion));
        return DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, actor) {
        const accepted = this._acceptSource(source);
        const index = accepted
            ? (this._ghost.index ?? this._container.get_children().length)
            : null;
        this.cancel();
        return this._onDrop(source, index, actor);
    }

    /** Delegate object to put on the strip container itself (empty-space drops). */
    delegate() {
        return {
            handleDragOver: source => this.handleDragOver(source),
            acceptDrop: (source, actor) => this.acceptDrop(source, actor),
        };
    }

    cancel() {
        this._ghost.clear();
        this._tooltip?.hide();
    }
}

// ==================== tooltip ====================
/**
 * The ONE floating text bubble. Used for the workspace-name hint, the
 * window-title popup, the pinned-icon name, and the drag insertion hint.
 * Anchored (above/below an actor), fixed (title popup), or at raw coords.
 */
export class Tooltip {
    constructor({ parent = null, styleClass = 'dmenu-tooltip', fontSize = null } = {}) {
        this._parent = parent;
        this._label = buildTooltipLabel(styleClass, fontSize);
        if (parent) parent.add_child(this._label);
        else Main.layoutManager.addChrome(this._label);
    }

    get visible() { return this._label.visible; }
    get hover() { return this._label.hover; }

    showAt(x, y, text) {
        this._label.set_text(text);
        this._label.show();
        this._place(Math.round(x), Math.round(y));
    }

    showAbove(actor, text, gap = 8) { this._showRelative(actor, text, gap, false); }
    showBelow(actor, text, gap = 8) { this._showRelative(actor, text, gap, true); }

    /** Fixed y (screen space), centred under `actor` and clamped to the screen. */
    showCentered(actor, text, y, padding = 10) {
        this._label.set_text(text);
        this._label.show();
        const width = this._label.width;
        const [actorX] = actor.get_transformed_position();
        let x = actorX + (actor.get_width() - width) / 2;
        x = Math.max(padding, Math.min(x, screenWidth - width - padding));
        this._place(Math.round(x), Math.round(y));
    }

    hide() { this._label.hide(); }

    destroy() {
        if (this._parent) {
            if (this._label.get_parent() === this._parent) this._parent.remove_child(this._label);
        } else {
            Main.layoutManager.removeChrome(this._label);
        }
        this._label.destroy();
    }

    _showRelative(actor, text, gap, preferBelow) {
        this._label.set_text(text);
        this._label.show();

        const [width, height] = this._label.get_size();
        const [actorX, actorY] = actor.get_transformed_position();
        const actorWidth = actor.get_width();
        const actorHeight = actor.get_height();

        const monitorIndex = Main.layoutManager.findIndexForActor(actor);
        const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;

        const edgePad = 6;
        const minX = monitor.x + edgePad;
        const maxX = monitor.x + monitor.width - width - edgePad;
        const minY = monitor.y + edgePad;
        const maxY = monitor.y + monitor.height - height - edgePad;

        let x = Math.round(actorX + (actorWidth - width) / 2);
        x = Math.max(minX, Math.min(x, maxX));

        const above = Math.round(actorY - height - gap);
        const below = Math.round(actorY + actorHeight + gap);

        let y;
        if (preferBelow) { y = below; if (y > maxY) y = above; }
        else { y = above; if (y < minY) y = below; }
        y = Math.max(minY, Math.min(y, maxY));

        this._place(x, y);
    }

    // Absolute stage coords → parent-relative when parented in an overlay.
    _place(x, y) {
        if (this._parent) {
            const [parentX, parentY] = this._parent.get_transformed_position();
            x -= parentX;
            y -= parentY;
        }
        this._label.set_position(x, y);
    }
}

// ==================== floating hover preview ====================
/** One clone preview at a time, owned by the indicator's WindowHoverPanel. */
export class HoverPreview {
    constructor({ settings }) {
        this._settings = settings;
        this._scope = new Scope();
        this._actor = null;
    }

    get visible() { return !!this._actor; }
    get hover() { return this._actor?.hover ?? false; }

    show({ window, anchor, onActivate, onClose, onHover }) {
        this.hide();
        const built = buildClonePreview(window, this._settings.get_int('hover-preview-height'), {
            wrapperStyleClass: 'hover-preview-wrapper',
            showTitle: false,
            closeButtonSize: this._settings.get_int('close-button-size'),
            closeButtonOffsetX: 60,
            closeButtonOffsetY: 10,
        });
        if (!built) return;

        if (built.wrapper) {
            this._scope.connect(built.wrapper, 'notify::hover', () => onHover?.(built.wrapper.hover));
            this._scope.connect(built.wrapper, 'button-press-event', (a, e) => {
                if (e.get_button() === Clutter.BUTTON_PRIMARY) { onActivate?.(); return Clutter.EVENT_STOP; }
                return Clutter.EVENT_PROPAGATE;
            });
        }
        if (built.closeButton)
            this._scope.connect(built.closeButton, 'clicked', () => { onClose?.(); return Clutter.EVENT_STOP; });

        const [anchorX] = anchor.get_transformed_position();
        const x = Math.max(0, anchorX + (anchor.get_width() - built.width) / 2);
        const y = screenHeight - built.height - 200 + 55;
        built.actor.set_position(x, y);

        this._actor = built.actor;
        Main.layoutManager.addChrome(this._actor);
        fadeInActor(this._actor);
    }

    hide() {
        this._scope.dispose();
        this._scope = new Scope();
        if (!this._actor) return;
        const actor = this._actor;
        this._actor = null;
        Main.layoutManager.removeChrome(actor);
        actor.destroy();
    }
}

// ==================== hover panel (indicator) ====================
/**
 * The single hover authority for window icons. Replaces the old
 * ActivePreviewTracker + per-icon preview/popup code with one object that:
 *   - debounces hover, is exclusive across icons, and cleans up on leave
 *   - swaps between the clone preview and the title tooltip on Ctrl
 *   - polls Ctrl only while something is showing
 */
export class WindowHoverPanel {
    static DEBOUNCE = 30;
    static CLEANUP = TimeoutDelay;
    static POLL = TimeoutDelay;

    constructor({ settings, tooltip }) {
        this._settings = settings;
        this._tooltip = tooltip;
        this._preview = new HoverPreview({ settings });
        this._scope = new Scope();

        this._owner = null;
        this._hoverId = 0;
        this._cleanupId = 0;
        this._pollId = 0;
        this._ctrl = false;
    }

    setHover(owner, hovering) {
        if (hovering) {
            if (this._hoverId) { this._scope.cancel(this._hoverId); this._hoverId = 0; }
            this._cancelCleanup();
            if (this._owner === owner) return;
            if (this._owner) this._hide();

            this._hoverId = this._scope.timeout(WindowHoverPanel.DEBOUNCE, () => {
                this._hoverId = 0;
                if (!owner.actor.hover) return GLib.SOURCE_REMOVE;
                this._owner = owner;
                this._render();
                this._startPoll();
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._owner === owner) {
            this._startCleanup();
        } else if (this._hoverId) {
            this._scope.cancel(this._hoverId);
            this._hoverId = 0;
        }
    }

    /** The preview bubble reports its own hover so it survives leaving the icon. */
    notifyHover(hovered) {
        if (hovered) this._cancelCleanup();
        else if (!this._owner?.actor.hover) this._startCleanup();
    }

    forget(owner) {
        if (this._owner !== owner) return;
        if (this._hoverId) { this._scope.cancel(this._hoverId); this._hoverId = 0; }
        this._hide();
    }

    destroy() {
        this._hide();
        this._preview.destroy?.();
        this._scope.dispose();
    }

    // ---- internals ----
    _render() {
        const owner = this._owner;
        if (!owner) return;
        if (this._ctrl) {
            this._preview.hide();
            const title = owner.window.get_title() || 'Untitled Window';
            this._tooltip.showCentered(owner.actor, title, screenHeight - 200);
        } else {
            this._tooltip.hide();
            this._preview.show({
                window: owner.window,
                anchor: owner.actor,
                onActivate: () => {
                    owner.window.get_workspace().activate_with_focus(owner.window, 0);
                    this._hide();
                },
                onClose: () => {
                    owner.window.delete(global.get_current_time());
                    this._hide();
                },
                onHover: h => this.notifyHover(h),
            });
        }
    }

    _hide() {
        this._stopPoll();
        this._preview.hide();
        this._tooltip.hide();
        this._owner = null;
    }

    _startCleanup() {
        this._cancelCleanup();
        this._cleanupId = this._scope.timeout(WindowHoverPanel.CLEANUP, () => {
            this._cleanupId = 0;
            if (this._owner && (this._owner.actor.hover || this._preview.hover || this._tooltip.hover))
                return GLib.SOURCE_REMOVE;
            this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelCleanup() {
        if (this._cleanupId) { this._scope.cancel(this._cleanupId); this._cleanupId = 0; }
    }

    _startPoll() {
        if (this._pollId) return;
        this._ctrl = WindowHoverPanel._readCtrl();
        this._pollId = this._scope.timeout(WindowHoverPanel.POLL, () => {
            if (!this._owner) { this._pollId = 0; return GLib.SOURCE_REMOVE; }
            const ctrl = WindowHoverPanel._readCtrl();
            if (ctrl !== this._ctrl) { this._ctrl = ctrl; this._render(); }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPoll() {
        if (this._pollId) { this._scope.cancel(this._pollId); this._pollId = 0; }
    }

    static _readCtrl() {
        const [, , mods] = global.get_pointer();
        return (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
    }
}

// ==================== external drag auto-activate ====================
/** Hovering an external drag (files, text) over an icon for ~400 ms raises it. */
export class ExternalDragActivator {
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

// ==================== context menu ====================
let _activeMenu = null;

export function closeActiveMenu() { _activeMenu?.close(); }

export function openMenu(anchor, populate, { translationY = 0 } = {}) {
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
    setIntent({ menuOpen: true }); // defers indicator renders while open
    menu.open(true);
    if (menu._boxPointer && translationY) menu._boxPointer.translation_y = translationY;
    return menu;
}

// ==================== window icon controller (indicator) ====================
/**
 * Everything imperative about one window icon: focus highlight, hover
 * (via the shared panel), clicks, context menu, external-drag
 * auto-activate, and its drag source. Rebuilt each render; the render scope
 * disposes it.
 */
export class WindowIconController {
    constructor({ window, actor, icon, settings, hoverPanel, strip, onRequestRender }) {
        this.window = window;
        this.actor = actor;

        this._settings = settings;
        this._hover = hoverPanel;
        this._strip = strip;
        this._external = new ExternalDragActivator(window);
        this._scope = new Scope();
        this._disposed = false;

        const iconSize = settings.get_int('icon-size');

        // Icon geometry (window menus / shell thumbnails). Re-set each
        // time the icon lands on stage.
        this._scope.connect(icon, 'stage-views-changed', () => {
            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = icon.get_transformed_position();
            [rect.width, rect.height] = icon.get_transformed_size();
            window.set_icon_geometry(rect);
        });

        // Identity changes need a full rebuild; focus toggles in place.
        this._scope.connect(window, 'notify::wm-class', onRequestRender);
        this._scope.connect(window, 'notify::mapped', onRequestRender);
        this._scope.connect(window, 'notify::appears-focused', () => this._syncFocus());

        this._scope.connect(actor, 'notify::hover', () => this._hover.setHover(this, actor.hover));
        this._scope.connect(actor, 'button-press-event', (a, e) => this._onPressed(e));
        this._scope.connect(actor, 'button-release-event', (a, e) => this._onReleased(e));

        makeDraggable(actor, {
            iconSize,
            payload: { kind: 'window', window, gicon: getWindowAppIcon(window) },
            getDragActor: () => buildDragActor(getWindowAppIcon(window), iconSize),
            hooks: {
                handleDragOver: (source) => {
                    if (source === actor._delegate) return DragMotionResult.CONTINUE;
                    if (!source?._dragPayload) this._external.notify();
                    return strip.handleDragOver(source);
                },
                acceptDrop: (source, dragActor) => strip.acceptDrop(source, dragActor),
            },
            onDragBegin: () => setIntent({ drag: { window, sourceIcon: actor, target: null } }),
            onDragEnd: () => setIntent({ drag: null, hintWs: null }),
        });

        this._syncFocus();
    }

    destroy() {
        if (this._disposed) return;
        this._disposed = true;
        this._hover.forget(this);
        this._external.destroy();
        this._scope.dispose();
        evictWindowIcon(this.window);
    }

    // ---- focus ----
    _syncFocus() {
        if (this.window.appears_focused) this.actor.add_style_class_name('focused');
        else this.actor.remove_style_class_name('focused');
    }

    // ---- clicks ----
    // Press: only the secondary menu. A primary press must NOT touch window
    // state, or the re-render would destroy this icon mid-press.
    _onPressed(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this._hover.forget(this);
            this._openMenu();
            return Clutter.EVENT_STOP;
        }
        return button === Clutter.BUTTON_PRIMARY ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    // Release: the real click. After a drag the release goes to DND's grab.
    _onReleased(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;

        this._hover.forget(this);
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
        openMenu(this.actor, m => {
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

    // True if any visible window stacked above `window` overlaps it, even
    // partially. Dialogs attached to the window itself don't count.
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
