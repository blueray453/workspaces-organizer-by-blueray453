import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { setIntent } from './model.js';

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

// ==================== DRAG AND DROP ====================
// Shared drag actor sizing / translucency for every reorderable icon.
export function createReorderDraggable(actor, iconSize, extraOptions = {}) {
    return DND.makeDraggable(actor, {
        restoreOnSuccess: false,
        dragActorMaxSize: iconSize,
        dragActorOpacity: 178, // ≈ 0.70 alpha, matches .reorder-drag-source
        ...extraOptions,
    });
}

// Makes `actor` (a window icon OR an overlay result row) a drag source
// for `window`. Dragging only sets a flag on the representation; the
// indicator renders the ghost and hides the source from it.
export function makeWindowDraggable(actor, window, iconSize, { delegate = {}, sourceIcon = false } = {}) {
    actor._window = window;
    actor._delegate = Object.assign(delegate, {
        getDragActorSource: () => actor,
        getDragActor: () => {
            const bin = new St.Bin({ style_class: 'window-preview-icon', width: iconSize, height: iconSize });
            bin.set_child(new St.Icon({ gicon: getWindowAppIcon(window), icon_size: iconSize }));
            bin.add_style_class_name('reorder-drag-source');
            return bin;
        },
    });
    const draggable = createReorderDraggable(actor, iconSize);
    draggable.connect('drag-begin', () =>
        setIntent({ drag: { window, sourceIcon: sourceIcon ? actor : null, target: null } }));
    draggable.connect('drag-end', () => setIntent({ drag: null, hintWs: null }));
    return draggable;
}

// ==================== CONTEXT MENU ====================
let _activeMenu = null;

export function closeActiveMenu() { _activeMenu?.close(); }

export function openContextMenu(anchor, populate) {
    closeActiveMenu();
    const menu = new PopupMenu.PopupMenu(anchor, 0.0, St.Side.TOP);
    menu.box.add_style_class_name('workspace-context-menu');
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
    return menu;
}

// ==================== FLOATING TOOLTIP ====================
export class FloatingTooltip {
    constructor({ parent = null, styleClass = 'dmenu-tooltip', fontSize = null } = {}) {
        this._parent = parent;
        this._label = new St.Label({ style_class: styleClass, visible: false });
        if (fontSize)
            this._label.set_style(`font-size: ${fontSize}pt;`);
        if (this._parent) this._parent.add_child(this._label);
        else Main.layoutManager.addChrome(this._label);
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

        // Absolute stage coords → parent-relative when parented in an overlay.
        if (this._parent) {
            const [parentX, parentY] = this._parent.get_transformed_position();
            x -= parentX;
            y -= parentY;
        }
        this._label.set_position(x, y);
    }

    hide() { this._label.hide(); }

    destroy() {
        if (this._parent) {
            if (this._label.get_parent() === this._parent)
                this._parent.remove_child(this._label);
        } else {
            Main.layoutManager.removeChrome(this._label);
        }
        this._label.destroy();
    }
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
