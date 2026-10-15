import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { setIntent } from './model.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

export const DragMotionResult = DND.DragMotionResult;

// ==================== WINDOW ICONS ====================
function resolveApp(window) {
    return Shell.WindowTracker.get_default().get_window_app(window) ||
        Shell.AppSystem.get_default().lookup_app(window.get_wm_class());
}

export function getWindowApp(window) { return resolveApp(window); }

export function getWindowAppIcon(window) {
    const app = resolveApp(window);
    if (app && app.get_app_info().get_icon())
        return app.get_icon();
    return window.get_gicon() || new Gio.ThemedIcon({ name: 'applications-system-symbolic' });
}

export function createWindowIconTexture(window, iconSize) {
    const app = resolveApp(window);
    if (app && app.get_app_info().get_icon())
        return app.create_icon_texture(iconSize);
    const icon = new St.Icon({ gicon: getWindowAppIcon(window), style_class: 'popup-menu-icon' });
    return St.TextureCache.get_default().load_gicon(null, icon, iconSize);
}

export function createGhostIcon(gicon, size) {
    const ghost = new St.Bin({ style_class: 'drag-placeholder-icon', width: size, height: size });
    ghost.opacity = 140;
    ghost._isGhost = true;
    if (gicon)
        ghost.set_child(new St.Icon({ gicon, icon_size: size }));
    return ghost;
}

// ==================== ICON CACHE ====================
// window -> { widget: St.Widget, size: number }
const _iconCache = new WeakMap();

export function evictWindowIcon(window) { _iconCache.delete(window); }

/**
 * Returns a cached icon widget for (window, size), stealing it back from
 * any old parent so it can be re-parented by the caller. Regenerated only
 * when the requested size changes or the entry was evicted.
 */
export function iconForWindow(window, iconSize) {
    const entry = _iconCache.get(window);
    if (entry?.size === iconSize) {
        const parent = entry.widget.get_parent();
        if (parent) parent.remove_child(entry.widget);
        return entry.widget;
    }
    const widget = createWindowIconTexture(window, iconSize);
    _iconCache.set(window, { widget, size: iconSize });
    return widget;
}

// ==================== INSERTION MATH ====================
// rects: [{ item, x, right, mid }] in left-to-right order.
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

// ==================== REORDER GHOST CONTROLLER ====================
/**
 * Imperative ghost controller for reorder drags. Reads item rects once at
 * drag start (filtering out anything without `_dragItem`), then anchors the
 * ghost to a neighbor actor via insert_child_below/above so placement is
 * correct while the source is still in the container.
 *
 * `index` counts positions among the NON-source items — the coordinate
 * system both placeWindow() and AppFavorites.moveFavoriteToPos() expect.
 */
export class ReorderGhostController {
    constructor({ iconSize, giconFor = source => source._dragPayload?.gicon } = {}) {
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
            this._ghost = createGhostIcon(this._giconFor(this._source), this._getIconSize());

        this._ghost.get_parent()?.remove_child(this._ghost);

        const { neighbor, insertBefore } = insertion;
        if (!neighbor) this._container.add_child(this._ghost);
        else if (insertBefore) this._container.insert_child_below(this._ghost, neighbor);
        else this._container.insert_child_above(this._ghost, neighbor);

        this._ghostIndex = insertion.index;
    }
}

// ==================== DRAG AND DROP ====================
export function createReorderDraggable(actor, iconSize, extraOptions = {}) {
    return DND.makeDraggable(actor, {
        restoreOnSuccess: false,
        dragActorMaxSize: iconSize,
        dragActorOpacity: 178,
        ...extraOptions,
    });
}

/**
 * The ONE way to make an actor draggable. Uniformly:
 *   - tags the actor with `_dragItem` + `_dragPayload` — how drop targets
 *     and ReorderGhostController identify and render it
 *   - installs `_delegate` (Shell passes it as `source` to drop targets)
 *   - dims the source on drag-begin and restores on drag-end
 *
 * The payload shape is free; every consumer reads it via `_dragPayload`.
 * Callers handle intent in onDragBegin / onDragEnd.
 */
export function makeDraggable(actor, {
    iconSize, payload, getDragActor = null, delegate = {}, onDragBegin = null, onDragEnd = null,
}) {
    actor._dragItem = true;
    actor._dragPayload = payload;
    actor._delegate = Object.assign(delegate, {
        _dragPayload: payload,
        _actor: actor,
        getDragActorSource: () => actor,
        getDragActor: getDragActor ?? (() => {
            const bin = new St.Bin({ style_class: 'window-preview-icon', width: iconSize, height: iconSize });
            if (payload?.gicon) bin.set_child(new St.Icon({ gicon: payload.gicon, icon_size: iconSize }));
            bin.add_style_class_name('reorder-drag-source');
            bin.opacity = 178;
            return bin;
        }),
    });

    const draggable = createReorderDraggable(actor, iconSize);
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

// ==================== DROP STRIP ====================
/**
 * The ONE drop target. Owns the ghost update, an optional insertion hint,
 * and the external-drag side effect. The caller supplies the semantics.
 *
 *   acceptSource(source) -> bool    is this a reorder of ours?
 *   onDragOver(source)              fired on every motion, before the ghost
 *   onExternalDragOver(source)      fired when the source isn't ours
 *   onDrop(source, index, actor)    index is null for external drags
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
        this._container = container;
        this._ghost = ghost;
        this._acceptSource = acceptSource;
        this._externalResult = externalResult;
        this._onDragOver = onDragOver;
        this._onExternalDragOver = onExternalDragOver;
        this._onDrop = onDrop;
        this._hint = hint;
        this._hintText = hintText;
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

        if (insertion && this._hint && this._hintText) {
            this._hint.show(insertion.neighbor ?? this._container, this._hintText(insertion));
        }
        return DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, actor) {
        const accepted = this._acceptSource(source);
        const index = accepted ? this._ghost.index : null;
        this.cancel();
        return this._onDrop(source, index, actor);
    }

    /** Delegate object to place on the container itself (empty-space drops). */
    delegate() {
        return {
            handleDragOver: source => this.handleDragOver(source),
            acceptDrop: (source, actor) => this.acceptDrop(source, actor),
        };
    }

    cancel() {
        this._ghost.clear();
        this._hint?.hide();
    }
}

// ==================== CONTEXT MENU ====================
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
    setIntent({ menuOpen: true }); // defers indicator renders while open
    menu.open(true);
    if (menu._boxPointer && translationY) menu._boxPointer.translation_y = translationY;
    return menu;
}

// ==================== FLOATING TOOLTIP ====================
export class FloatingTooltip {
    constructor({ parent = null, styleClass = 'dmenu-tooltip', fontSize = null } = {}) {
        this._parent = parent;
        this._label = new St.Label({
            style_class: styleClass,
            visible: false,
            reactive: true,
            track_hover: true,
        });
        this.setFontSize(fontSize);
        if (parent) parent.add_child(this._label);
        else Main.layoutManager.addChrome(this._label);
    }

    get label() { return this._label; }
    get hover() { return this._label.hover; }

    setFontSize(pt) {
        if (pt != null) this._label.set_style(`font-size: ${pt}pt;`);
    }

    showAbove(actor, text, gap = 8) { this._show(actor, text, gap, false); }
    showBelow(actor, text, gap = 8) { this._show(actor, text, gap, true); }

    _show(actor, text, gap, preferBelow) {
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

        if (this._parent) {
            const [parentX, parentY] = this._parent.get_transformed_position();
            x -= parentX;
            y -= parentY;
        } else {
            try { Main.layoutManager.uiGroup.set_child_above_sibling(this._label, null); }
            catch (e) { /* no siblings yet */ }
        }
        this._label.set_position(x, y);
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
}

// ==================== SHARED TOOLTIP ====================
// One tooltip for the whole extension. Callers do NOT own it.
let _sharedTooltip = null;

function _ensureSharedTooltip() {
    if (!_sharedTooltip) _sharedTooltip = new FloatingTooltip();
    return _sharedTooltip;
}

export function showTooltipAbove(anchor, text, fontSize = null) {
    const t = _ensureSharedTooltip();
    t.setFontSize(fontSize);
    t.showAbove(anchor, text);
}

export function showTooltipBelow(anchor, text, fontSize = null) {
    const t = _ensureSharedTooltip();
    t.setFontSize(fontSize);
    t.showBelow(anchor, text);
}

export function hideTooltip() { _sharedTooltip?.hide(); }

export function destroyTooltip() {
    _sharedTooltip?.destroy();
    _sharedTooltip = null;
}

// ==================== CLONE PREVIEW ====================
const LAYOUT = { TITLE_HEIGHT_MIN: 40, TITLE_HEIGHT_MAX: 100, TITLE_HEIGHT_FRACTION: 0.2 };

export function createClonePreviewActor(window, targetHeight, options = {}) {
    if (!window) return null;
    const windowActor = window.get_compositor_private();
    if (!windowActor) return null;

    const windowFrame = window.get_frame_rect();
    const bufferFrame = window.get_buffer_rect();
    if (windowFrame.height === 0) return null;

    const targetWidth = targetHeight * (windowFrame.width / windowFrame.height);
    const scale = targetHeight / windowFrame.height;
    const scaledLeftShadow = (windowFrame.x - bufferFrame.x) * scale;
    const scaledTopShadow = (windowFrame.y - bufferFrame.y) * scale;
    const scaledRightShadow = ((bufferFrame.x + bufferFrame.width) - (windowFrame.x + windowFrame.width)) * scale;
    const scaledBottomShadow = ((bufferFrame.y + bufferFrame.height) - (windowFrame.y + windowFrame.height)) * scale;

    const container = new St.BoxLayout({
        style_class: 'collection-preview-inner',
        width: targetWidth,
        height: targetHeight,
        clip_to_allocation: true,
    });

    const clone = new Clutter.Clone({
        source: windowActor,
        width: targetWidth + scaledLeftShadow + scaledRightShadow,
        height: targetHeight + scaledTopShadow + scaledBottomShadow,
    });
    clone.set_position(-scaledLeftShadow, -scaledTopShadow);

    const cloneContainer = new Clutter.Actor();
    cloneContainer.add_child(clone);
    container.add_child(cloneContainer);

    if (options.showTitle !== false) {
        const titleText = window.get_title();
        const label = titleText && titleText.trim() ? titleText : 'Untitled';
        const titleHeight = Math.min(LAYOUT.TITLE_HEIGHT_MAX,
            Math.max(LAYOUT.TITLE_HEIGHT_MIN, targetHeight * LAYOUT.TITLE_HEIGHT_FRACTION));
        const title = new St.Label({
            style_class: 'clone-title-overlay',
            text: label,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        title.clutter_text.set_y_align(Clutter.ActorAlign.CENTER);
        title.clutter_text.set_line_wrap(true);
        title.set_size(targetWidth, titleHeight);
        title.set_position(0, (targetHeight - titleHeight) / 2);
        cloneContainer.add_child(title);
    }

    if (options.onClose) {
        const closeIconSize = options.closeButtonSize ?? 32;
        const closeOffsetX = options.closeButtonOffsetX ?? (closeIconSize + 14);
        const closeOffsetY = options.closeButtonOffsetY ?? 10;
        const closeButton = new St.Button({
            style_class: 'window-close-button',
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: closeIconSize }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            reactive: true,
        });
        closeButton.set_position(targetWidth - closeOffsetX, closeOffsetY);
        closeButton.connect('clicked', () => {
            options.onClose(window);
            return Clutter.EVENT_STOP;
        });
        cloneContainer.add_child(closeButton);
    }

    if (!options.wrapperStyleClass)
        return { actor: container, width: targetWidth, height: targetHeight };

    const wrapper = new St.BoxLayout({
        style_class: options.wrapperStyleClass,
        reactive: true,
        track_hover: true,
    });
    wrapper.add_child(container);

    if (options.onHoverChange)
        wrapper.connect('notify::hover', () => options.onHoverChange(wrapper.hover));

    if (options.onActivate) {
        wrapper.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                options.onActivate();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }
    return { actor: wrapper, inner: container, width: targetWidth, height: targetHeight };
}