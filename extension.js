import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { setLogging, setLogFn, journal } from './utils.js';

// Get screen dimensions
const screenWidth = global.get_screen_width();
const screenHeight = global.get_screen_height();
const WorkspaceManager = global.get_workspace_manager();
const WindowTracker = global.get_window_tracker();
const Display = global.get_display();
const TimeoutDelay = 200;
const DIRECT_MODE_MAX_WINDOWS = 5;

const LAYOUT = {
    TITLE_HEIGHT_MIN: 40,
    TITLE_HEIGHT_MAX: 100,
    TITLE_HEIGHT_FRACTION: 0.2,
};

// ==================== FUZZY MATCHING ====================
function subsequenceMatch(query, text) {
    let qi = 0, score = 0, consecutive = 0;
    for (let ti = 0; ti < text.length && qi < query.length; ti++) {
        if (text[ti] === query[qi]) {
            score += 1 + consecutive;
            consecutive++;
            qi++;
        } else {
            consecutive = 0;
        }
    }
    if (qi < query.length)
        return { matched: false, score: -1 };
    return { matched: true, score };
}

function fuzzyMatch(query, text) {
    const trimmed = query.trim();
    if (!trimmed)
        return { matched: true, score: 0 };
    const lowerText = text.toLowerCase();
    const tokens = trimmed.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    let score = 0;
    for (const token of tokens) {
        const idx = lowerText.indexOf(token);
        if (idx !== -1) {
            score += 50 - Math.min(idx, 40);
            continue;
        }
        const sub = subsequenceMatch(token, lowerText);
        if (!sub.matched)
            return { matched: false, score: -1 };
        score += sub.score;
    }
    return { matched: true, score };
}

// ==================== SHARED CLONE-PREVIEW BUILDER ====================
function createClonePreviewActor(window, targetHeight, options = {}) {
    if (!window)
        return null;

    const windowActor = window.get_compositor_private();
    if (!windowActor)
        return null;

    const windowFrame = window.get_frame_rect();
    const bufferFrame = window.get_buffer_rect();
    if (windowFrame.height === 0)
        return null;

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
        const titleHeight = Math.min(
            LAYOUT.TITLE_HEIGHT_MAX,
            Math.max(LAYOUT.TITLE_HEIGHT_MIN, targetHeight * LAYOUT.TITLE_HEIGHT_FRACTION)
        );
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
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: closeIconSize,
            }),
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

    if (options.onHoverChange) {
        wrapper.connect('notify::hover', () => {
            options.onHoverChange(wrapper.hover);
        });
    }

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

// ==================== DRAG DROP MANAGER ====================
const DragDropManager = {
    _sourcePreview: null,
    _placeholder: null,
    _placeholderBox: null,
    _lastInsertion: null,
    _snapshot: null,

    beginDrag(sourcePreview) {
        if (this._sourcePreview && this._sourcePreview !== sourcePreview)
            this.endDrag();
        this._sourcePreview = sourcePreview;
        this._snapshot = null;
        if (typeof sourcePreview.add_style_class_name === 'function')
            sourcePreview.add_style_class_name('reorder-drag-source');
    },

    endDrag() {
        this._clearPlaceholder();
        this._snapshot = null;
        if (this._sourcePreview) {
            try {
                this._sourcePreview.remove_style_class_name('reorder-drag-source');
            } catch (e) {
                // actor may already be destroyed
            }
        }
        this._sourcePreview = null;
    },

    clearIfRelated(actor) {
        if (this._sourcePreview === actor) {
            this._clearPlaceholder();
            this._snapshot = null;
            this._sourcePreview = null;
            return;
        }
        if (this._placeholderBox === actor)
            this._clearPlaceholder();
    },

    _snapshotRects(box, order, draggedWindow) {
        if (this._snapshot && this._snapshot.box === box)
            return this._snapshot.rects;

        const rects = [];
        for (const w of order) {
            if (w === draggedWindow)
                continue;
            const preview = box.get_children().find(c => c._window === w);
            if (!preview || !preview.get_stage())
                continue;
            const [x] = preview.get_transformed_position();
            const [width] = preview.get_transformed_size();
            rects.push({ window: w, x, width, mid: x + width / 2, right: x + width });
        }
        this._snapshot = { box, rects };
        return rects;
    },

    computeInsertionFromPointer(draggedWindow, order, pointerX, box) {
        const rects = this._snapshotRects(box, order, draggedWindow);
        if (rects.length === 0)
            return { insertIndex: 0 };

        const first = rects[0];
        const last = rects[rects.length - 1];
        let target = null;
        let insertBefore = true;

        if (pointerX < first.x) {
            target = first;
            insertBefore = true;
        } else if (pointerX >= last.right) {
            target = last;
            insertBefore = false;
        } else {
            for (const r of rects) {
                if (pointerX >= r.x && pointerX < r.right) {
                    target = r;
                    insertBefore = pointerX < r.mid;
                    break;
                }
            }
            if (!target) {
                for (let i = 0; i < rects.length - 1; i++) {
                    const left = rects[i], right = rects[i + 1];
                    if (pointerX >= left.right && pointerX <= right.x) {
                        const distanceToLeft = pointerX - left.right;
                        const distanceToRight = right.x - pointerX;
                        target = distanceToLeft <= distanceToRight ? left : right;
                        insertBefore = target === right;
                        break;
                    }
                }
            }
            if (!target) {
                let nearest = rects[0];
                let best = Math.abs(pointerX - nearest.mid);
                for (const r of rects) {
                    const d = Math.abs(pointerX - r.mid);
                    if (d < best) { best = d; nearest = r; }
                }
                target = nearest;
                insertBefore = pointerX < nearest.mid;
            }
        }

        const orderWithout = order.filter(w => w !== draggedWindow);
        let targetIndex = orderWithout.indexOf(target.window);
        if (targetIndex === -1)
            targetIndex = orderWithout.length;

        return { insertIndex: insertBefore ? targetIndex : targetIndex + 1 };
    },

    updatePlaceholder(box, index) {
        if (!this._sourcePreview || !box)
            return;
        if (this._placeholderBox === box && this._lastInsertion?.index === index)
            return;

        const placeholder = this._ensurePlaceholder();
        if (!placeholder)
            return;

        if (placeholder.get_parent())
            placeholder.get_parent().remove_child(placeholder);

        const count = box.get_children().length;
        const clamped = Math.max(0, Math.min(index, count));
        box.insert_child_at_index(placeholder, clamped);

        this._placeholderBox = box;
        this._lastInsertion = { box, index: clamped };
    },

    clearPlaceholder() {
        this._clearPlaceholder();
    },

    getLastInsertion() {
        return this._lastInsertion;
    },

    _ensurePlaceholder() {
        if (this._placeholder)
            return this._placeholder;
        if (!this._sourcePreview)
            return null;
        const size = this._sourcePreview.icon_size ?? 96;
        const placeholder = new St.Bin({
            style_class: 'window-preview-icon drag-placeholder-icon',
            width: size,
            height: size,
        });
        placeholder.opacity = 140;
        const iconActor = this._sourcePreview.get_child();
        if (iconActor)
            placeholder.set_child(new Clutter.Clone({ source: iconActor }));
        this._placeholder = placeholder;
        return placeholder;
    },

    _clearPlaceholder() {
        if (!this._placeholder)
            return;
        if (this._placeholder.get_parent())
            this._placeholder.get_parent().remove_child(this._placeholder);
        this._placeholder.destroy();
        this._placeholder = null;
        this._placeholderBox = null;
        this._lastInsertion = null;
    },
};

// ==================== THUMBNAIL REGISTRY ====================
const ThumbnailRegistry = {
    _thumbnails: new Set(),
    register(thumb) {
        this._thumbnails.add(thumb);
    },
    unregister(thumb) {
        this._thumbnails.delete(thumb);
    },
    getAll() {
        return [...this._thumbnails];
    },
};

// ==================== REORDER HELPERS ====================
function getDraggedWindow(source) {
    if (!source)
        return null;
    if (source._window)
        return source._window;
    if (source.realWindow && typeof source.realWindow.get_meta_window === 'function')
        return source.realWindow.get_meta_window();
    return null;
}

// ==================== TITLE BAR DRAG MONITOR ====================
class TitleBarDragMonitor {
    constructor() {
        this._grabbedWindow = null;
        this._dragPollId = 0;
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;

        this._beginId = global.display.connect('grab-op-begin',
            (display, window, op) => this._onGrabOpBegin(window, op));
        this._endId = global.display.connect('grab-op-end',
            (display, window, op) => this._onGrabOpEnd(window, op));
    }

    _isMoveOp(op) {
        return op === Meta.GrabOp.MOVING ||
            op === Meta.GrabOp.KEYBOARD_MOVING;
    }

    _onGrabOpBegin(window, op) {
        if (!this._isMoveOp(op))
            return;
        journal(`[TitleBarDragMonitor] Move grab started: ${window?.title}`);
        this._currentDragWindow = window;
        this._lastSwitchedWorkspace = null;
        this._startDragPoll();
    }

    _onGrabOpEnd(window, op) {
        const grabbed = this._currentDragWindow;
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;
        this._stopDragPoll();

        if (!grabbed || grabbed !== window || !this._isMoveOp(op))
            return;

        const [pointerX, pointerY] = global.get_pointer();
        const target = this._findThumbnailAt(pointerX, pointerY);
        if (target) {
            journal(`[TitleBarDragMonitor] Dropped "${window.title}" onto workspace ${target._workspace.index()}`);
            target._moveWindow(window);
        }
    }

    _findThumbnailAt(x, y) {
        for (const thumb of ThumbnailRegistry.getAll()) {
            if (!thumb.get_stage())
                continue;
            const [tx, ty] = thumb.get_transformed_position();
            const tw = thumb.width;
            const th = thumb.height;
            if (x >= tx && x <= tx + tw && y >= ty && y <= ty + th)
                return thumb;
        }
        return null;
    }

    _startDragPoll() {
        if (this._dragPollId) {
            GLib.Source.remove(this._dragPollId);
            this._dragPollId = 0;
        }
        journal(`[TitleBarDragMonitor] Starting drag poll`);
        this._dragPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            100,
            () => this._onDragPollTick()
        );
    }

    _stopDragPoll() {
        if (this._dragPollId) {
            GLib.Source.remove(this._dragPollId);
            this._dragPollId = 0;
            journal(`[TitleBarDragMonitor] Stopped drag poll`);
        }
    }

    _onDragPollTick() {
        if (!this._currentDragWindow) {
            this._stopDragPoll();
            return GLib.SOURCE_REMOVE;
        }

        const [px, py] = global.get_pointer();
        const thumb = this._findThumbnailAt(px, py);
        if (!thumb)
            return GLib.SOURCE_CONTINUE;

        const targetWs = thumb._workspace;
        const currentWs = WorkspaceManager.get_active_workspace();

        if (targetWs === currentWs || targetWs === this._lastSwitchedWorkspace)
            return GLib.SOURCE_CONTINUE;

        journal(`[TitleBarDragMonitor] Hover switch to workspace ${targetWs.index()}`);

        const window = this._currentDragWindow;
        const monitorIndex = Main.layoutManager.findIndexForActor(thumb);
        if (monitorIndex !== window.get_monitor())
            window.move_to_monitor(monitorIndex);

        window.change_workspace(targetWs);
        targetWs.activate(global.get_current_time());
        this._lastSwitchedWorkspace = targetWs;

        return GLib.SOURCE_CONTINUE;
    }

    destroy() {
        this._stopDragPoll();
        if (this._beginId) {
            global.display.disconnect(this._beginId);
            this._beginId = null;
        }
        if (this._endId) {
            global.display.disconnect(this._endId);
            this._endId = null;
        }
        this._currentDragWindow = null;
        this._grabbedWindow = null;
    }
}

// ==================== PREVIEW REGISTRY WITH CTRL POLLING ====================
const PreviewRegistry = {
    activePreview: null,
    _ctrlPollId: null,
    _ctrlPressed: false,

    registerPreview(preview) {
        journal(`[PreviewRegistry] Registering preview for window: ${preview._window.title}`);
        if (this.activePreview && this.activePreview !== preview) {
            journal(`[PreviewRegistry] Cleaning up previous preview`);
            this.activePreview._forceHide('new preview registered');
        }
        this.activePreview = preview;
        this._startCtrlPoll();
    },

    unregisterPreview(preview) {
        if (this.activePreview === preview) {
            journal(`[PreviewRegistry] Unregistering preview for window: ${preview._window.title}`);
            this.activePreview = null;
            this._stopCtrlPoll();
        }
    },

    _checkCtrlKeyState() {
        const [, , mods] = global.get_pointer();
        this._ctrlPressed = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
    },

    _startCtrlPoll() {
        if (this._ctrlPollId) {
            journal(`[PreviewRegistry] Ctrl poll already running`);
            return;
        }
        if (!this.activePreview) {
            journal(`[PreviewRegistry] No active preview, skipping Ctrl poll`);
            return;
        }
        this._checkCtrlKeyState();
        journal(`[PreviewRegistry] Starting Ctrl poll, initial state: ${this._ctrlPressed}`);
        this._ctrlPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TimeoutDelay,
            () => {
                return this._onCtrlPollTick();
            }
        );
    },

    _stopCtrlPoll() {
        if (this._ctrlPollId) {
            const sourceId = this._ctrlPollId;
            this._ctrlPollId = null;
            if (GLib.Source.remove(sourceId))
                journal(`[PreviewRegistry] Stopped Ctrl poll`);
        }
    },

    _onCtrlPollTick() {
        if (!this.activePreview) {
            journal(`[PreviewRegistry] No active preview, stopping Ctrl poll`);
            this._stopCtrlPoll();
            return GLib.SOURCE_REMOVE;
        }
        const [, , mods] = global.get_pointer();
        const ctrlDown = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrlDown !== this._ctrlPressed) {
            this._ctrlPressed = ctrlDown;
            journal(`[PreviewRegistry] Ctrl state changed: ${this._ctrlPressed}`);
            if (this.activePreview)
                this.activePreview._onCtrlChanged(ctrlDown);
        }
        return GLib.SOURCE_CONTINUE;
    },

    getCurrentCtrlState() {
        return this._ctrlPressed;
    },

    destroy() {
        journal(`[PreviewRegistry] Destroying`);
        this._stopCtrlPoll();
        this.activePreview = null;
    }
};

// ==================== CONTROLLER: Window Icon Renderer ====================
class WindowIconRenderer {
    constructor(parentActor, window) {
        this._parent = parentActor;
        this._window = window;
        this._iconSize = 96;
        this._signalId = null;

        this._updateIcon();
        this._wmClassChangedId = this._window.connect('notify::wm-class', this._updateIcon.bind(this));
        this._mappedId = this._window.connect('notify::mapped', this._updateIcon.bind(this));
    }

    _updateIcon() {
        const app = Shell.WindowTracker.get_default().get_window_app(this._window) ||
            Shell.AppSystem.get_default().lookup_app(this._window.get_wm_class());
        let iconActor = null;
        if (app && app.get_app_info().get_icon()) {
            iconActor = app.create_icon_texture(this._iconSize);
            this._parent.set_child(iconActor);
        } else {
            let gicon = this._window.get_gicon();
            if (!gicon)
                gicon = new Gio.ThemedIcon({ name: 'applications-system-symbolic' });
            const icon = new St.Icon({
                gicon: gicon,
                style_class: 'popup-menu-icon'
            });
            iconActor = St.TextureCache.get_default().load_gicon(null, icon, this._iconSize);
            this._parent.set_child(iconActor);
        }

        // Set icon geometry for window
        const signalId = iconActor.connect('stage-views-changed', (actor) => {
            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = iconActor.get_transformed_position();
            [rect.width, rect.height] = iconActor.get_transformed_size();
            this._window.set_icon_geometry(rect);
            iconActor.disconnect(signalId);
        });
        this._signalId = signalId;
    }

    setIconSize(size) {
        if (size !== this._iconSize) {
            this._iconSize = size;
            this._updateIcon();
        }
    }

    destroy() {
        if (this._wmClassChangedId && this._window) {
            this._window.disconnect(this._wmClassChangedId);
            this._wmClassChangedId = null;
        }
        if (this._mappedId && this._window) {
            this._window.disconnect(this._mappedId);
            this._mappedId = null;
        }
        // The icon actor is child of parent; it will be destroyed with parent
    }
}

// ==================== CONTROLLER: Window Context Menu ====================
class WindowContextMenu {
    constructor(window, anchorActor) {
        this._window = window;
        this._anchor = anchorActor;
        this._menu = null;
        this._menuManager = null;
    }

    open() {
        if (this._menu) {
            this._menu.open(true);
            return;
        }

        let menu = new PopupMenu.PopupMenu(this._anchor, 0.0, St.Side.TOP);
        menu.box.add_style_class_name('workspace-context-menu');
        this._menu = menu;
        this._menuManager = new PopupMenu.PopupMenuManager(this._anchor);
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        const win = this._window;
        menu.addAction(`Activate ${win.title}`, () => {
            let win_workspace = win.get_workspace();
            win_workspace.activate_with_focus(win, 0);
        });

        menu.addAction(`Close ${win.title}`, () => {
            win.delete(0);
        });

        menu.addAction(`Close Except ${win.title}`, () => {
            const targetWmClass = win.get_wm_class();
            const windowsToClose = Display.get_tab_list(
                Meta.TabList.NORMAL,
                win.get_workspace()
            ).filter(w =>
                w !== win &&
                w.get_wm_class() === targetWmClass &&
                w.get_wm_class_instance() !== 'file_progress'
            );
            const currentTime = global.get_current_time();
            for (const window of windowsToClose) {
                journal(`Closing window: ${window.get_title()}`);
                window.delete(currentTime);
            }
        });

        const app = WindowTracker.get_window_app(win);
        const appInfo = app?.get_app_info();
        const actions = appInfo?.list_actions();
        if (actions && actions.length > 0) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            actions.forEach(action => {
                menu.addAction(`${appInfo.get_action_name(action)}`, () => {
                    app.launch_action(action, 0, -1);
                });
            });
        }

        menu.open(true);
        if (menu._boxPointer)
            menu._boxPointer.translation_y = -35;
    }

    close() {
        if (this._menu) {
            this._menu.close();
            // menu will be destroyed when closed?
            this._menu = null;
            this._menuManager = null;
        }
    }

    destroy() {
        this.close();
    }
}

// ==================== CONTROLLER: Hover Preview ====================
class HoverPreviewController {
    constructor(anchorActor, window) {
        this._anchor = anchorActor;
        this._window = window;
        this._previewActor = null;
        this._cleanupTimeoutId = null;
        this._isShowing = false;
    }

    show() {
        if (this._isShowing) {
            this._updatePreview();
            return;
        }

        const previewHeight = 800;
        const built = createClonePreviewActor(this._window, previewHeight, {
            wrapperStyleClass: 'hover-preview-wrapper',
            showTitle: false,
            onClose: (win) => {
                win.delete(global.get_current_time());
                this.hide();
            },
            closeButtonSize: 48,
            closeButtonOffsetX: 60,
            closeButtonOffsetY: 10,
            onHoverChange: (isHovered) => {
                if (this._anchor._onPreviewHoverChange)
                    this._anchor._onPreviewHoverChange(isHovered);
            },
            onActivate: () => {
                this._window.get_workspace().activate_with_focus(this._window, 0);
                this.hide();
            },
        });

        if (!built)
            return;

        const windowPreviewWidth = this._anchor.get_width();
        const [windowPreviewX, windowPreviewY] = this._anchor.get_transformed_position();
        const previewX = Math.max(0, windowPreviewX + (windowPreviewWidth - built.width) / 2);
        const previewY = screenHeight - previewHeight - 200 + 55;

        built.actor.set_position(previewX, previewY);
        this._previewActor = built.actor;
        Main.layoutManager.addChrome(this._previewActor);

        this._previewActor.opacity = 0;
        this._previewActor.ease({
            opacity: 255,
            duration: TimeoutDelay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._isShowing = true;
        journal(`[HoverPreviewController] Shown`);
    }

    _updatePreview() {
        // For simplicity, we hide and re-show. Could be optimized but okay.
        if (this._isShowing) {
            this.hide();
            this.show();
        }
    }

    hide() {
        if (!this._isShowing)
            return;
        if (this._previewActor) {
            const actor = this._previewActor;
            this._previewActor = null;
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._isShowing = false;
        this._cancelCleanup();
        journal(`[HoverPreviewController] Hidden`);
    }

    isShowing() {
        return this._isShowing;
    }

    startCleanup(delay = TimeoutDelay) {
        this._cancelCleanup();
        this._cleanupTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._cleanupTimeoutId = null;
                // Check hover states via anchor's methods if needed
                const iconHovered = this._anchor.hover || false;
                const previewHovered = this._previewActor?.hover || false;
                if (iconHovered || previewHovered) {
                    journal(`[HoverPreviewController] Cleanup aborted - still hovering`);
                    return GLib.SOURCE_REMOVE;
                }
                this.hide();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelCleanup() {
        if (this._cleanupTimeoutId) {
            GLib.source_remove(this._cleanupTimeoutId);
            this._cleanupTimeoutId = null;
        }
    }

    destroy() {
        this.hide();
        this._cancelCleanup();
    }
}

// ==================== CONTROLLER: Title Popup ====================
class TitlePopupController {
    constructor(anchorActor, window) {
        this._anchor = anchorActor;
        this._window = window;
        this._popupActor = null;
        this._isShowing = false;
        this._hoverSignalId = null;
    }

    show() {
        if (this._isShowing)
            return;

        const title = this._window.get_title() || "Untitled Window";
        const label = new St.Label({
            text: title,
            style_class: "hover-title-popup",
            reactive: true,
            track_hover: true,
        });
        Main.layoutManager.addChrome(label);

        let [iconX, iconY] = this._anchor.get_transformed_position();
        const iconWidth = this._anchor.width;
        const padding = 10;
        const maxWidth = screenWidth - (2 * padding);
        const labelWidth = Math.min(label.width, maxWidth);
        let labelX = iconX + (iconWidth - labelWidth) / 2;
        labelX = Math.max(padding, labelX);
        labelX = Math.min(labelX, screenWidth - labelWidth - padding);
        const labelY = screenHeight - 200;

        label.set_position(labelX, labelY);
        this._popupActor = label;

        label.opacity = 0;
        label.ease({
            opacity: 255,
            duration: TimeoutDelay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._hoverSignalId = label.connect("notify::hover", () => {
            if (this._anchor._onPreviewHoverChange)
                this._anchor._onPreviewHoverChange(label.hover);
        });

        this._isShowing = true;
        journal(`[TitlePopupController] Shown`);
    }

    hide() {
        if (!this._isShowing)
            return;
        if (this._popupActor) {
            const actor = this._popupActor;
            this._popupActor = null;
            if (this._hoverSignalId) {
                actor.disconnect(this._hoverSignalId);
                this._hoverSignalId = null;
            }
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._isShowing = false;
        journal(`[TitlePopupController] Hidden`);
    }

    isShowing() {
        return this._isShowing;
    }

    destroy() {
        this.hide();
    }
}

// ==================== CONTROLLER: External Drag Activator ====================
class ExternalDragActivator {
    constructor(window) {
        this._window = window;
        this._dragActivateTimeoutId = null;
        this._lastDragOverTime = 0;
    }

    handleDragOver() {
        this._lastDragOverTime = GLib.get_monotonic_time();

        if (!this._dragActivateTimeoutId) {
            journal(`[ExternalDragActivator] External drag hovering, scheduling activate`);
            this._dragActivateTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                400,
                () => {
                    this._dragActivateTimeoutId = null;
                    const elapsedMs = (GLib.get_monotonic_time() - this._lastDragOverTime) / 1000;
                    if (elapsedMs > 500) {
                        journal(`[ExternalDragActivator] Drag left before activation, aborting`);
                        return GLib.SOURCE_REMOVE;
                    }
                    this._activateWindow();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    _activateWindow() {
        if (!this._window) return;
        journal(`[ExternalDragActivator] Activating window for drag-hover: ${this._window.title}`);
        const win = this._window;
        if (win.minimized) win.unminimize();
        const winWs = win.get_workspace();
        winWs.activate_with_focus(win, global.get_current_time());
    }

    destroy() {
        if (this._dragActivateTimeoutId) {
            GLib.source_remove(this._dragActivateTimeoutId);
            this._dragActivateTimeoutId = null;
        }
    }
}

// ==================== WINDOW PREVIEW CLASS (Coordinator) ====================
class WindowPreview extends St.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(window) {
        super({
            style_class: 'window-preview-icon',
            reactive: true,
            track_hover: true,
        });

        this._window = window;
        this.icon_size = 96;

        // Controllers
        this._iconRenderer = new WindowIconRenderer(this, window);
        this._contextMenu = new WindowContextMenu(window, this);
        this._hoverPreview = new HoverPreviewController(this, window);
        this._titlePopup = new TitlePopupController(this, window);
        this._dragActivator = new ExternalDragActivator(window);

        // Timers / state
        this._cleanupTimeoutId = null;
        this._hoverTimeoutId = null;

        // DND setup
        this._delegate = this;
        this._draggable = DND.makeDraggable(this, { restoreOnSuccess: true });
        journal(`[WindowPreview] DND draggable created for ${window.title}`);

        this._draggable.connect('drag-begin', () => {
            journal(`[WindowPreview] Drag began for ${this._window.title}`);
            DragDropManager.beginDrag(this);
        });

        this._draggable.connect('drag-end', () => {
            journal(`[WindowPreview] Drag ended for ${this._window.title}`);
            DragDropManager.endDrag();

            const thumbnail = this._getThumbnail();
            if (thumbnail && typeof thumbnail._syncChildOrder === 'function') {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
                    if (typeof thumbnail._syncChildOrder === 'function')
                        thumbnail._syncChildOrder();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        // Connect hover signal
        this._hoverSignalId = this.connect('notify::hover', () => {
            journal(`[WindowPreview] Icon hover changed: ${this.hover}`);
            this._onIconHoverChange();
        });

        // Connect button press signal
        this._buttonPressedId = this.connect('button-press-event',
            this._onButtonPressed.bind(this));

        // Connect workspace change signal
        this._wsChangedId = WorkspaceManager.connect('workspace-switched', () => {
            journal(`[WindowPreview] Workspace switched`);
            this._forceHide('workspace switched');
            if (this._contextMenu) {
                this._contextMenu.close();
            }
        });
    }

    _getThumbnail() {
        const box = this.get_parent();
        return box ? box.get_parent() : null;
    }

    // ==================== HOVER MANAGEMENT ====================
    _onIconHoverChange() {
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }
        if (this.hover) {
            this._cancelCleanup();
            if (this._hoverPreview.isShowing() || this._titlePopup.isShowing()) {
                journal(`[WindowPreview] Already showing preview, updating immediately`);
                this._updatePreview();
                return;
            }
            this._hoverTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                30,
                () => {
                    this._hoverTimeoutId = null;
                    PreviewRegistry.registerPreview(this);
                    this._showPreview();
                    return GLib.SOURCE_REMOVE;
                }
            );
        } else {
            if (this._hoverPreview.isShowing() || this._titlePopup.isShowing())
                this._startCleanup();
        }
    }

    _onPreviewHoverChange(isHovered) {
        journal(`[WindowPreview] Preview hover changed: ${isHovered}, icon hover: ${this.hover}`);
        if (isHovered) {
            this._cancelCleanup();
        } else {
            if (!this.hover)
                this._startCleanup();
        }
    }

    _onCtrlChanged(ctrlPressed) {
        journal(`[WindowPreview] Ctrl changed: ${ctrlPressed}`);
        if (ctrlPressed) {
            this._titlePopup.show();
            this._hoverPreview.hide();
        } else {
            this._hoverPreview.show();
            this._titlePopup.hide();
        }
    }

    // ==================== PREVIEW DISPLAY ====================
    _showPreview() {
        if (!this._window) {
            journal(`[WindowPreview] No window available`);
            return;
        }
        const shouldShow = this.hover || this._hoverPreview.isShowing() || this._titlePopup.isShowing();
        if (!shouldShow) {
            journal(`[WindowPreview] Not hovering anymore, aborting`);
            return;
        }
        const ctrlPressed = PreviewRegistry.getCurrentCtrlState();
        if (ctrlPressed)
            this._titlePopup.show();
        else
            this._hoverPreview.show();
    }

    _updatePreview() {
        const ctrlPressed = PreviewRegistry.getCurrentCtrlState();
        if (ctrlPressed) {
            this._titlePopup.show();
            this._hoverPreview.hide();
        } else {
            this._hoverPreview.show();
            this._titlePopup.hide();
        }
    }

    _forceHide(reason = '') {
        journal(`[WindowPreview] Force hiding${reason ? `: ${reason}` : ''}`);
        this._cancelCleanup();
        PreviewRegistry.unregisterPreview(this);
        this._hoverPreview.hide();
        this._titlePopup.hide();
    }

    // ==================== CLEANUP MANAGEMENT ====================
    _startCleanup() {
        this._stopCleanupTimer();
        journal(`[WindowPreview] Starting cleanup timer`);
        this._cleanupTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TimeoutDelay,
            () => {
                this._cleanupTimeoutId = null;
                const iconHovered = this.hover;
                const previewHovered = this._hoverPreview._previewActor?.hover || false;
                const titleHovered = this._titlePopup._popupActor?.hover || false;
                if (iconHovered || previewHovered || titleHovered) {
                    journal(`[WindowPreview] Cleanup aborted - still hovering`);
                    return GLib.SOURCE_REMOVE;
                }
                journal(`[WindowPreview] Cleanup timer completed`);
                PreviewRegistry.unregisterPreview(this);
                this._hoverPreview.hide();
                this._titlePopup.hide();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelCleanup() {
        this._stopCleanupTimer();
    }

    _stopCleanupTimer() {
        if (this._cleanupTimeoutId) {
            journal(`[WindowPreview] Stopping cleanup timer`);
            GLib.source_remove(this._cleanupTimeoutId);
            this._cleanupTimeoutId = null;
        }
    }

    // ==================== DRAG HOVER ACTIVATION ====================
    handleDragOver(source, actor, x, y, time) {
        journal(`[WindowPreview] handleDragOver source=${source?.constructor?.name}, window=${this._window?.title}`);

        if (source instanceof WindowPreview) {
            const draggedWindow = source._window;
            const thumbnail = this._getThumbnail();

            journal(`[WindowPreview] Window-icon drag detected, target=${this._window?.title}, thumbnail=${!!thumbnail}`);

            if (thumbnail && typeof thumbnail.handleWindowDragOver === 'function')
                return thumbnail.handleWindowDragOver(draggedWindow, this, x, y, time);

            return DND.DragMotionResult.CONTINUE;
        }

        // External drag
        this._dragActivator.handleDragOver();
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, actor, x, y, time) {
        journal(`[WindowPreview] acceptDrop source=${source?.constructor?.name}`);

        if (source instanceof WindowPreview) {
            const draggedWindow = source._window;
            const thumbnail = this._getThumbnail();

            journal(`[WindowPreview] Window-icon drop, target=${this._window?.title}, thumbnail=${!!thumbnail}`);

            if (thumbnail && typeof thumbnail.acceptWindowDrop === 'function')
                return thumbnail.acceptWindowDrop(draggedWindow, this, x, y, time);

            return false;
        }

        return false;
    }

    // ==================== EVENT HANDLERS ====================
    _onButtonPressed(actor, event) {
        let button = event.get_button();
        if (button === Clutter.BUTTON_PRIMARY) {
            journal(`[WindowPreview] Left click`);
            this._forceHide('left click');
            const win = this._window;
            const currentWs = WorkspaceManager.get_active_workspace();
            const winWs = win.get_workspace();
            if (winWs === currentWs) {
                if (win.minimized) {
                    win.unminimize();
                    win.activate_with_workspace(0, winWs);
                } else if (this._is_covered(win)) {
                    win.activate_with_workspace(0, winWs);
                } else {
                    win.minimize();
                }
                return Clutter.EVENT_STOP;
            }
            winWs.activate_with_focus(win, 0);
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_SECONDARY) {
            journal(`[WindowPreview] Right click`);
            this._forceHide('right click');
            this._contextMenu.open();
            return Clutter.EVENT_STOP;
        }
    }

    // ==================== UTILITY ====================
    _is_covered(window) {
        if (window.minimized) return false;
        let current_workspace = WorkspaceManager.get_active_workspace();
        let windows_by_stacking = Display.sort_windows_by_stacking(
            Display.list_all_windows()
                .filter(win =>
                    (win.get_window_type() === Meta.WindowType.NORMAL ||
                        win.get_window_type() === Meta.WindowType.DIALOG) &&
                    win.get_workspace() === current_workspace)
        );
        let targetRect = window.get_frame_rect();
        let targetIndex = windows_by_stacking.indexOf(window);
        for (let i = targetIndex + 1; i < windows_by_stacking.length; i++) {
            let topWin = windows_by_stacking[i];
            let topRect = topWin.get_frame_rect();
            if (
                topRect.x <= targetRect.x &&
                topRect.y <= targetRect.y &&
                topRect.x + topRect.width >= targetRect.x + targetRect.width &&
                topRect.y + topRect.height >= targetRect.y + targetRect.height
            ) {
                return true;
            }
        }
        return false;
    }

    get realWindow() {
        return this._window.get_compositor_private();
    }

    destroy() {
        journal(`[WindowPreview] Destroying`);
        DragDropManager.clearIfRelated(this);
        this._forceHide('destroy');

        if (this._hoverSignalId) {
            this.disconnect(this._hoverSignalId);
            this._hoverSignalId = null;
        }
        if (this._buttonPressedId) {
            this.disconnect(this._buttonPressedId);
            this._buttonPressedId = null;
        }
        if (this._wsChangedId && WorkspaceManager) {
            WorkspaceManager.disconnect(this._wsChangedId);
            this._wsChangedId = null;
        }
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        this._iconRenderer.destroy();
        this._contextMenu.destroy();
        this._hoverPreview.destroy();
        this._titlePopup.destroy();
        this._dragActivator.destroy();

        if (this.get_child())
            this.set_child(null);

        super.destroy();
        journal(`[WindowPreview] Destroyed`);
    }
}

// ==================== WINDOW COLLECTION OVERLAY ====================
class WindowCollectionOverlay {
    constructor(windows) {
        journal(`[CollectionOverlay] Opening with ${windows.length} windows`);
        this._windows = windows;
        this._results = [];
        this._resultButtons = [];
        this._selectedIndex = -1;
        this._previewClone = null;
        this._modalGrab = null;
        this._closed = false;
        this._buildUI();
        this._setResults(this._getAllResultsSorted());
        this._open();
    }

    _getAppName(window) {
        const app = WindowTracker.get_window_app(window);
        return app ? app.get_name() : (window.get_wm_class() || 'Unknown');
    }

    _getAllResultsSorted() {
        const items = this._windows
            .filter(w => w && !w.skip_taskbar)
            .map(w => ({
                window: w,
                title: w.get_title() || 'Untitled Window',
                appName: this._getAppName(w),
            }));
        items.sort((a, b) => {
            const appCompare = a.appName.localeCompare(b.appName);
            if (appCompare !== 0)
                return appCompare;
            return a.title.localeCompare(b.title);
        });
        return items;
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        this._monitorGeom = monitor;
        this._container = new St.Widget({
            style_class: 'window-collection-overlay',
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });

        const margin = 40;
        const entryHeight = 60;
        const entryGap = 20;
        const panelWidth = monitor.width - margin * 2;
        const panelX = monitor.x + margin;
        const entryY = monitor.y + margin;
        const panelTop = entryY + entryHeight + entryGap;
        const panelHeight = monitor.height - (panelTop - monitor.y) - margin;
        const resultsWidth = Math.round(panelWidth * 0.32);
        const previewWidth = panelWidth - resultsWidth - 20;

        this._entry = new St.Entry({
            style_class: 'collection-search-entry',
            hint_text: 'Search windows…',
            can_focus: true,
            x: panelX,
            y: entryY,
            width: panelWidth,
            height: entryHeight,
        });

        this._resultsScroll = new St.ScrollView({
            style_class: 'collection-results-scroll',
            x: panelX,
            y: panelTop,
            width: resultsWidth,
            height: panelHeight,
        });
        this._resultsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        this._resultsBox = new St.BoxLayout({
            style_class: 'collection-results-box',
            vertical: true,
            x_expand: true,
        });
        this._resultsScroll.set_child(this._resultsBox);

        this._previewBox = new St.BoxLayout({
            style_class: 'collection-preview-box',
            x: panelX + resultsWidth + 20,
            y: panelTop,
            width: previewWidth,
            height: panelHeight,
        });

        this._container.add_child(this._entry);
        this._container.add_child(this._resultsScroll);
        this._container.add_child(this._previewBox);

        this._entryChangedId = this._entry.clutter_text.connect('text-changed',
            () => this._onSearchChanged());
        this._entryKeyPressId = this._entry.clutter_text.connect('key-press-event',
            (actor, event) => this._onKeyPress(event));
    }

    _open() {
        Main.layoutManager.addChrome(this._container, {
            affectsInputRegion: true,
            trackFullscreen: true,
        });
        Main.layoutManager.uiGroup.set_child_above_sibling(this._container, null);
        this._modalGrab = Main.pushModal(this._container, {
            actionMode: Shell.ActionMode.NORMAL,
        });
        this._entry.grab_key_focus();
    }

    _close() {
        if (this._closed) return;
        this._closed = true;
        journal(`[CollectionOverlay] Closing`);
        this._clearPreview();
        if (this._modalGrab) {
            Main.popModal(this._modalGrab);
            this._modalGrab = null;
        }
        if (this._entry?.clutter_text) {
            this._entry.clutter_text.disconnect(this._entryChangedId);
            this._entry.clutter_text.disconnect(this._entryKeyPressId);
        }
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
    }

    _onSearchChanged() {
        if (this._closed) return;
        const query = this._entry.get_text();
        const all = this._getAllResultsSorted();
        if (!query.trim()) {
            this._setResults(all);
            return;
        }
        const scored = [];
        for (const item of all) {
            const label = `${item.title} — ${item.appName}`;
            const result = fuzzyMatch(query, label);
            if (result.matched)
                scored.push({ ...item, score: result.score });
        }
        scored.sort((a, b) => b.score - a.score);
        this._setResults(scored);
    }

    _setResults(results) {
        this._results = results;
        this._resultsBox.destroy_all_children();
        this._resultButtons = [];
        this._selectedIndex = -1;

        results.forEach((item, index) => {
            const button = new St.Button({
                style_class: 'collection-result-item',
                label: `${item.title}  —  ${item.appName}`,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                track_hover: true,
                reactive: true,
            });

            button._delegate = button;
            button.realWindow = item.window.get_compositor_private();

            const draggable = DND.makeDraggable(button, { restoreOnSuccess: false });
            button._draggable = draggable;
            draggable.connect('drag-begin', () => this._onResultDragBegin(button));

            button.connect('clicked', () => this._activateResult(index));
            button.connect('notify::hover', () => {
                if (button.hover)
                    this._selectIndex(index);
            });

            this._resultsBox.add_child(button);
            this._resultButtons.push(button);
        });

        if (results.length > 0)
            this._selectIndex(0);
        else
            this._clearPreview();
    }

    _selectIndex(index) {
        if (this._closed) return;
        if (index < 0 || index >= this._results.length)
            return;
        if (this._selectedIndex >= 0 && this._resultButtons[this._selectedIndex])
            this._resultButtons[this._selectedIndex].remove_style_class_name('selected');
        this._selectedIndex = index;
        this._resultButtons[index]?.add_style_class_name('selected');
        this._updatePreview(this._results[index].window);
    }

    _updatePreview(window) {
        this._clearPreview();
        const windowFrame = window.get_frame_rect();
        if (windowFrame.height === 0) return;

        const aspect = windowFrame.width / windowFrame.height;
        let targetHeight = this._previewBox.height;
        let targetWidth = targetHeight * aspect;

        if (targetWidth > this._previewBox.width) {
            targetWidth = this._previewBox.width;
            targetHeight = targetWidth / aspect;
        }

        const built = createClonePreviewActor(window, targetHeight, {
            onClose: (win) => this._closeWindowFromPreview(win),
        });
        if (!built) return;

        built.actor.set_position(
            Math.max(0, (this._previewBox.width - built.width) / 2),
            Math.max(0, (this._previewBox.height - built.height) / 2)
        );

        this._previewBox.add_child(built.actor);
        this._previewClone = built.actor;
    }

    _clearPreview() {
        if (!this._previewClone)
            return;
        if (this._previewClone.get_parent() === this._previewBox)
            this._previewBox.remove_child(this._previewClone);
        this._previewClone.destroy();
        this._previewClone = null;
    }

    _closeWindowFromPreview(window) {
        if (this._closed) return;
        journal(`[CollectionOverlay] Closing window from preview: ${window.title}`);
        window.delete(global.get_current_time());

        const closedIndex = this._results.findIndex(item => item.window === window);
        if (closedIndex === -1)
            return;

        this._results.splice(closedIndex, 1);
        this._windows = this._windows.filter(w => w !== window);

        const button = this._resultButtons[closedIndex];
        if (button) {
            if (button.get_parent() === this._resultsBox)
                this._resultsBox.remove_child(button);
            button.destroy();
        }
        this._resultButtons.splice(closedIndex, 1);

        if (this._results.length === 0) {
            this._selectedIndex = -1;
            this._clearPreview();
            return;
        }

        const nextIndex = Math.min(closedIndex, this._results.length - 1);
        this._selectedIndex = -1;
        this._selectIndex(nextIndex);
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (!item)
            return;
        const window = item.window;
        journal(`[CollectionOverlay] Activating: ${window.title}`);
        if (window.minimized)
            window.unminimize();
        window.get_workspace().activate_with_focus(window, global.get_current_time());
        this._close();
    }

    _onResultDragBegin(button) {
        if (this._closed)
            return;
        this._closed = true;
        journal(`[CollectionOverlay] Drag started on result — closing overlay, drag continues`);
        this._clearPreview();
        if (this._modalGrab) {
            Main.popModal(this._modalGrab);
            this._modalGrab = null;
        }
        if (this._entry?.clutter_text) {
            this._entry.clutter_text.disconnect(this._entryChangedId);
            this._entry.clutter_text.disconnect(this._entryKeyPressId);
        }

        Main.layoutManager.removeChrome(this._container);
        this._container.hide();

        const draggable = button._draggable;
        if (!draggable) {
            this._container.destroy();
            return;
        }

        const endId = draggable.connect('drag-end', () => {
            draggable.disconnect(endId);
            journal(`[CollectionOverlay] Drag finished, disposing overlay`);
            this._container.destroy();
        });
    }

    _onKeyPress(event) {
        if (this._closed) return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        switch (symbol) {
            case Clutter.KEY_Escape:
                this._close();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                if (this._selectedIndex < this._results.length - 1)
                    this._selectIndex(this._selectedIndex + 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
                if (this._selectedIndex > 0)
                    this._selectIndex(this._selectedIndex - 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
                if (this._selectedIndex >= 0)
                    this._activateResult(this._selectedIndex);
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }
}

// ==================== WINDOW COLLECTION ICON ====================
class WindowCollectionIcon extends St.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(getWindowsFn) {
        super({
            style_class: 'workspace-thumbnail-collection-icon',
            reactive: true,
            track_hover: true,
            can_focus: true,
        });

        this._getWindowsFn = getWindowsFn;
        this._label = new St.Label({
            style_class: 'collection-icon-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._label);
        this._clickedId = this.connect('clicked', () => this._openOverlay());
    }

    setCount(count) {
        this._label.set_text(`▱ ${count}`);
    }

    _openOverlay() {
        const windows = this._getWindowsFn();
        new WindowCollectionOverlay(windows);
    }

    destroy() {
        if (this._clickedId) {
            this.disconnect(this._clickedId);
            this._clickedId = null;
        }
        super.destroy();
    }
}

// ==================== WINDOW ORDER STORE ====================
class WindowOrderStore {
    constructor(workspace) {
        this._workspace = workspace;
        this._order = [];
        this._pendingInsertIndices = new Map();
        this._addWindowTimeoutIds = new Map();

        // Listen to workspace signals to add/remove windows
        this._windowAddedId = workspace.connect('window-added', (ws, win) => this._addWindow(win));
        this._windowRemovedId = workspace.connect('window-removed', (ws, win) => this._removeWindow(win));
        this._windowCreatedId = Display.connect('window-created', (display, win) => {
            if (win.get_workspace() === this._workspace)
                this._addWindow(win);
        });

        // Initial population
        this._workspace.list_windows().forEach(w => this._addWindow(w));
    }

    get order() {
        return this._order;
    }

    _addWindow(window) {
        if (window.skip_taskbar)
            return;

        if (this._order.includes(window)) {
            this._pendingInsertIndices.delete(window);
            return;
        }

        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }

        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
            this._addWindowTimeoutIds.delete(window);

            if (window.get_workspace() !== this._workspace)
                return GLib.SOURCE_REMOVE;

            if (!this._order.includes(window)) {
                if (this._pendingInsertIndices.has(window)) {
                    const idx = Math.max(
                        0,
                        Math.min(
                            this._pendingInsertIndices.get(window),
                            this._order.length
                        )
                    );
                    this._order.splice(idx, 0, window);
                } else {
                    this._order.push(window);
                }
            }

            this._pendingInsertIndices.delete(window);
            this._emitOrderChanged();
            return GLib.SOURCE_REMOVE;
        });

        this._addWindowTimeoutIds.set(window, sourceId);
    }

    _removeWindow(window) {
        this._pendingInsertIndices.delete(window);

        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }

        const idx = this._order.indexOf(window);
        if (idx === -1)
            return;

        this._order.splice(idx, 1);
        this._emitOrderChanged();
    }

    reorderWindowToIndex(window, insertIndex) {
        if (insertIndex === null)
            return;

        const currentIndex = this._order.indexOf(window);
        if (currentIndex === -1) {
            if (window.get_workspace() === this._workspace) {
                const idx = Math.max(0, Math.min(insertIndex, this._order.length));
                this._order.splice(idx, 0, window);
                this._emitOrderChanged();
            }
            return;
        }

        this._order.splice(currentIndex, 1);
        const idx = Math.max(0, Math.min(insertIndex, this._order.length));
        this._order.splice(idx, 0, window);
        this._emitOrderChanged();
    }

    setPendingInsertIndex(window, index) {
        this._pendingInsertIndices.set(window, index);
    }

    cleanupSources() {
        for (const [, id] of this._addWindowTimeoutIds)
            GLib.Source.remove(id);
        this._addWindowTimeoutIds.clear();
    }

    destroy() {
        this.cleanupSources();
        this._pendingInsertIndices.clear();
        if (this._windowAddedId)
            this._workspace.disconnect(this._windowAddedId);
        if (this._windowRemovedId)
            this._workspace.disconnect(this._windowRemovedId);
        if (this._windowCreatedId)
            Display.disconnect(this._windowCreatedId);
    }

    _emitOrderChanged() {
        // We'll use a custom signal mechanism (could use Signals.EventEmitter, but we'll keep simple)
        if (this._onOrderChanged) this._onOrderChanged();
    }

    setOnOrderChanged(callback) {
        this._onOrderChanged = callback;
    }
}

// ==================== DISPLAY MODE SWITCHER ====================
class DisplayModeSwitcher {
    constructor(box, orderStore) {
        this._box = box;
        this._orderStore = orderStore;
        this._windowPreviews = new Map();
        this._collectionIcon = null;
        this._mode = 'direct';

        this._orderStore.setOnOrderChanged(() => this.sync());
        this.sync();
    }

    sync() {
        const count = this._orderStore.order.length;
        if (count > DIRECT_MODE_MAX_WINDOWS)
            this._enterCollectionMode(count);
        else
            this._enterDirectMode();
    }

    _enterCollectionMode(count) {
        // Remove all window previews
        for (const preview of this._windowPreviews.values()) {
            if (preview.get_parent() === this._box)
                this._box.remove_child(preview);
            preview.destroy();
        }
        this._windowPreviews.clear();

        if (!this._collectionIcon) {
            this._collectionIcon = new WindowCollectionIcon(() => this._orderStore.order.slice());
            this._box.add_child(this._collectionIcon);
        }
        this._collectionIcon.setCount(count);
        this._mode = 'collection';
    }

    _enterDirectMode() {
        // Remove collection icon if present
        if (this._collectionIcon) {
            if (this._collectionIcon.get_parent() === this._box)
                this._box.remove_child(this._collectionIcon);
            this._collectionIcon.destroy();
            this._collectionIcon = null;
        }

        const currentWindows = new Set(this._orderStore.order);

        // 1. Remove previews for windows no longer in the order
        for (const [window, preview] of this._windowPreviews) {
            if (!currentWindows.has(window)) {
                if (preview.get_parent() === this._box)
                    this._box.remove_child(preview);
                preview.destroy();
                this._windowPreviews.delete(window);
            }
        }

        // 2. Add previews for windows in the order that don't have one yet
        for (const window of this._orderStore.order) {
            if (this._windowPreviews.has(window))
                continue;
            if (!this._box || !this._box.get_stage())
                continue;

            let preview = new WindowPreview(window);
            preview.connect('clicked', () => {
                this._orderStore._workspace.activate(0);
                window.activate(0);
            });

            this._windowPreviews.set(window, preview);
            this._box.add_child(preview);
        }

        this._mode = 'direct';
        this._syncChildOrder();
        this._updateThumbnailSize();
    }

    _syncChildOrder() {
        if (this._mode !== 'direct' || !this._box)
            return;

        const orderedPreviews = [];
        for (const window of this._orderStore.order) {
            const preview = this._windowPreviews.get(window);
            if (!preview)
                continue;
            if (preview.get_parent() === this._box)
                this._box.remove_child(preview);
            orderedPreviews.push(preview);
        }

        for (const preview of orderedPreviews)
            this._box.add_child(preview);
    }

    _updateThumbnailSize() {
        let iconSize = 96;
        const count = this._windowPreviews.size;
        if (count >= 7) iconSize = 48;
        else if (count >= 5) iconSize = 72;
        for (let preview of this._windowPreviews.values()) {
            if (preview.icon_size !== iconSize) {
                preview.icon_size = iconSize;
                preview._iconRenderer.setIconSize(iconSize);
            }
        }
    }

    getPreviews() {
        return this._windowPreviews;
    }

    getMode() {
        return this._mode;
    }

    destroy() {
        for (const preview of this._windowPreviews.values()) {
            if (preview.get_parent() === this._box)
                this._box.remove_child(preview);
            preview.destroy();
        }
        this._windowPreviews.clear();
        if (this._collectionIcon) {
            if (this._collectionIcon.get_parent() === this._box)
                this._box.remove_child(this._collectionIcon);
            this._collectionIcon.destroy();
            this._collectionIcon = null;
        }
    }
}

// ==================== WORKSPACE THUMBNAIL (Coordinator) ====================
class WorkspaceThumbnail extends St.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(workspace) {
        super({
            style_class: 'workspace-thumbnail',
            x_expand: true,
            y_expand: true,
        });

        this._workspace = workspace;
        this._windowsBox = new St.BoxLayout();
        this.set_child(this._windowsBox);

        // Order store and display mode switcher
        this._orderStore = new WindowOrderStore(workspace);
        this._displayMode = new DisplayModeSwitcher(this._windowsBox, this._orderStore);

        // Keep references for DragDropManager
        this._windowOrder = this._orderStore.order;

        ThumbnailRegistry.register(this);

        this._delegate = this;

        // Context menu
        this._contextMenu = null;

        // Workspace switch signal to close context menu
        this._wsChangedId = WorkspaceManager.connect('workspace-switched', () => {
            if (this._contextMenu) {
                this._contextMenu.close();
                this._contextMenu = null;
            }
        });

        // Click on thumbnail to switch workspace
        this.connect('button-press-event', (actor, event) => {
            let button = event.get_button();
            if (button === Clutter.BUTTON_PRIMARY) {
                this._workspace.activate(0);
            }
            if (button === Clutter.BUTTON_SECONDARY) {
                this._showContextMenu();
            }
            return Clutter.EVENT_STOP;
        });

        // Restacked signal – not needed for reorder, but kept for compatibility
        this._restackedId = Display.connect('restacked', () => { });
    }

    _showContextMenu() {
        const windows = Display.get_tab_list(Meta.TabList.NORMAL, this._workspace);
        const windowCount = windows.length;
        let menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP);
        menu.box.add_style_class_name('workspace-context-menu');
        this._contextMenu = menu;
        let manager = new PopupMenu.PopupMenuManager(this);
        manager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        menu.addAction('Close all windows on all workspaces', () => {
            let windowsToClose = Display.get_tab_list(Meta.TabList.NORMAL, null);
            const currentTime = global.get_current_time();
            for (const window of windowsToClose) {
                journal(`Closing window: ${window.get_title()}`);
                window.delete(currentTime);
            }
        });

        if (windowCount > 0) {
            menu.addAction(
                `Close all windows except workspace ${this._workspace.index()}`,
                () => {
                    let windowsToClose = Display.get_tab_list(Meta.TabList.NORMAL, null).filter(w =>
                        w.get_workspace() !== this._workspace
                    );
                    const currentTime = global.get_current_time();
                    for (const window of windowsToClose) {
                        journal(`Closing window: ${window.get_title()}`);
                        window.delete(currentTime);
                    }
                }
            );
            menu.addAction(
                `Close all windows on workspace ${this._workspace.index()}`,
                () => {
                    const currentTime = global.get_current_time();
                    for (const window of windows) {
                        journal(`Closing window: ${window.get_title()}`);
                        window.delete(currentTime);
                    }
                }
            );
        }
        menu.open(true);
    }

    // ==================== DND TARGET METHODS ====================
    handleDragOver(source, actor, x, y, time) {
        const draggedWindow = getDraggedWindow(source);
        if (!draggedWindow)
            return DND.DragMotionResult.CONTINUE;

        if (this._displayMode.getMode() !== 'direct')
            return DND.DragMotionResult.MOVE_DROP;

        const [pointerX] = global.get_pointer();
        const insertion = DragDropManager.computeInsertionFromPointer(
            draggedWindow, this._windowOrder, pointerX, this._windowsBox);
        DragDropManager.updatePlaceholder(this._windowsBox, insertion.insertIndex);

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, actor, x, y, time) {
        const draggedWindow = getDraggedWindow(source);
        if (!draggedWindow)
            return false;

        const last = DragDropManager.getLastInsertion();
        const insertIndex = last && last.box === this._windowsBox ? last.index : null;
        this._moveWindow(draggedWindow, insertIndex);
        DragDropManager.clearPlaceholder();
        return true;
    }

    handleWindowDragOver(draggedWindow, targetPreview, x, y, time) {
        if (!draggedWindow || targetPreview?._window === draggedWindow)
            return DND.DragMotionResult.MOVE_DROP;
        return this.handleDragOver({ _window: draggedWindow }, null, x, y, time);
    }

    acceptWindowDrop(draggedWindow, targetPreview, x, y, time) {
        if (!draggedWindow)
            return false;
        return this.acceptDrop({ _window: draggedWindow }, null, x, y, time);
    }

    // ==================== WINDOW MOVEMENT ====================
    _moveWindow(window, insertIndex = null) {
        const wasSameWorkspace = window.get_workspace() === this._workspace;

        let monitorIndex = Main.layoutManager.findIndexForActor(this);
        if (monitorIndex !== window.get_monitor())
            window.move_to_monitor(monitorIndex);

        if (insertIndex !== null && !wasSameWorkspace)
            this._orderStore.setPendingInsertIndex(window, insertIndex);

        window.change_workspace(this._workspace);

        if (insertIndex !== null && wasSameWorkspace)
            this._orderStore.reorderWindowToIndex(window, insertIndex);
    }

    _syncChildOrder() {
        this._displayMode._syncChildOrder();
    }

    cleanupSources() {
        this._orderStore.cleanupSources();
    }

    destroy() {
        if (this._wsChangedId && WorkspaceManager) {
            WorkspaceManager.disconnect(this._wsChangedId);
            this._wsChangedId = null;
        }
        if (this._restackedId) {
            Display.disconnect(this._restackedId);
            this._restackedId = null;
        }
        if (this._contextMenu) {
            this._contextMenu.close();
            this._contextMenu = null;
        }
        DragDropManager.clearIfRelated(this._windowsBox);
        ThumbnailRegistry.unregister(this);

        this._orderStore.destroy();
        this._displayMode.destroy();

        super.destroy();
    }
}

// ==================== WORKSPACE INDICATOR ====================
class WorkspaceIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(0.0, _('Workspace Indicator'));
        this.reactive = false;

        this._mainBox = new St.BoxLayout({
            style_class: 'workspace-indicator-main-box',
            y_expand: true,
            x_expand: true,
            reactive: true,
        });

        this._workspaceName = new St.Label({
            style_class: 'workspace-name-label',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            text: this._getCurrentWorkspaceName(),
        });

        this._thumbnailsBox = new St.BoxLayout({
            style_class: 'workspace-indicator-class',
            y_expand: true,
            x_expand: true,
            reactive: true,
        });

        this._mainBox.add_child(this._workspaceName);
        this._mainBox.add_child(this._thumbnailsBox);
        this.add_child(this._mainBox);

        this._workspaceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._workspaceSection);

        this._workspaceManagerSignals = [
            WorkspaceManager.connect_after('notify::n-workspaces',
                this._updateThumbnails.bind(this)),
            WorkspaceManager.connect_after('workspace-switched',
                this._onWorkspaceSwitched.bind(this)),
        ];

        this._updateThumbnails();
    }

    _getCurrentWorkspaceName() {
        const workspaceManager = global.workspace_manager;
        const currentWorkspace = workspaceManager.get_active_workspace_index();
        return Meta.prefs_get_workspace_name(currentWorkspace);
    }

    _onWorkspaceSwitched() {
        this._workspaceName.set_text(this._getCurrentWorkspaceName());
        this._updateActiveThumbnail();
    }

    _updateActiveThumbnail() {
        let thumbs = this._thumbnailsBox.get_children();
        for (let i = 0; i < thumbs.length; i++) {
            if (i === WorkspaceManager.get_active_workspace_index())
                thumbs[i].add_style_class_name('active');
            else
                thumbs[i].remove_style_class_name('active');
        }
    }

    destroy() {
        this.cleanupSources();
        this._thumbnailsBox?.destroy();
        for (let i = 0; i < this._workspaceManagerSignals.length; i++)
            WorkspaceManager.disconnect(this._workspaceManagerSignals[i]);
        Main.panel.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        super.destroy();
    }

    _updateThumbnails() {
        this._thumbnailsBox.destroy_all_children();
        for (let i = 0; i < WorkspaceManager.n_workspaces; i++) {
            let thumb = new WorkspaceThumbnail(WorkspaceManager.get_workspace_by_index(i));
            this._thumbnailsBox.add_child(thumb);
        }
        this._updateActiveThumbnail();
    }

    cleanupSources() {
        let thumbs = this._thumbnailsBox.get_children();
        for (let i = 0; i < thumbs.length; i++) {
            if (typeof thumbs[i].cleanupSources === 'function')
                thumbs[i].cleanupSources();
        }
    }
}

// ==================== EXTENSION ENTRY ====================
export default class TopNotchWorkspaces extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._handles = [];
        this._origUpdateSwitcher = null;
        this._titleBarDragMonitor = null;
    }

    enable() {
        setLogFn((msg, error = false) => {
            let level;
            if (error)
                level = GLib.LogLevelFlags.LEVEL_CRITICAL;
            else
                level = GLib.LogLevelFlags.LEVEL_MESSAGE;

            GLib.log_structured(
                'workspaces-organizer-by-blueray453',
                level,
                {
                    MESSAGE: `${msg}`,
                    SYSLOG_IDENTIFIER: 'workspaces-organizer-by-blueray453',
                    CODE_FILE: GLib.filename_from_uri(import.meta.url)[0]
                }
            );
        });
        setLogging(true);
        journal(`Enabled`);

        this._indicator = new WorkspaceIndicator();
        Main.panel.addToStatusArea('workspace-indicator', this._indicator, 0, 'left');

        this._titleBarDragMonitor = new TitleBarDragMonitor();
    }

    disable() {
        if (this._titleBarDragMonitor) {
            this._titleBarDragMonitor.destroy();
            this._titleBarDragMonitor = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}