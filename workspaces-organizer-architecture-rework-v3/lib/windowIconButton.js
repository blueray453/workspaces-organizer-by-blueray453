import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import { WorkspaceManager, Display, TimeoutDelay } from './shellGlobals.js';
import { WindowReorderDragController } from './windowReorderDragController.js';
import { createWindowIconTexture, getWindowApp } from './windowIconTexture.js';
import { createClonePreviewActor } from './clonePreviewActor.js';
import { fadeInActor } from './animationHelpers.js';


import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== ACTIVE PREVIEW TRACKER ====================
// Centralized manager for "which WindowIconButton currently has its hover
// preview or title popup open" plus the shared CTRL-key poll that decides
// which of the two to show. Only one preview can be active at a time, and
// polling only runs while one is active. Singleton — internal to this
// file, only WindowIconButton itself touches it.
const ActivePreviewTracker = {
    activePreview: null,
    _ctrlPollId: null,
    _ctrlPressed: false,

    registerPreview(preview) {
        if (this.activePreview && this.activePreview !== preview)
            this.activePreview.forceHidePreview('new preview registered');
        this.activePreview = preview;
        this._startCtrlPoll();
    },

    unregisterPreview(preview) {
        if (this.activePreview === preview) {
            this.activePreview = null;
            this._stopCtrlPoll();
        }
    },

    _checkCtrlKeyState() {
        const [, , mods] = global.get_pointer();
        this._ctrlPressed = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
    },

    _startCtrlPoll() {
        if (this._ctrlPollId || !this.activePreview)
            return;
        this._checkCtrlKeyState();
        this._ctrlPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => this._onCtrlPollTick());
    },

    _stopCtrlPoll() {
        if (this._ctrlPollId) {
            GLib.Source.remove(this._ctrlPollId);
            this._ctrlPollId = null;
        }
    },

    _onCtrlPollTick() {
        if (!this.activePreview) {
            this._stopCtrlPoll();
            return GLib.SOURCE_REMOVE;
        }
        const [, , mods] = global.get_pointer();
        const ctrlDown = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrlDown !== this._ctrlPressed) {
            this._ctrlPressed = ctrlDown;
            this.activePreview?.onCtrlChanged(ctrlDown);
        }
        return GLib.SOURCE_CONTINUE;
    },

    getCurrentCtrlState() {
        return this._ctrlPressed;
    },
};

// ==================== EXTERNAL DRAG AUTO-ACTIVATOR ====================
// Lets you drag a file/text/tab from elsewhere, hover over a window icon,
// and have the underlying window raise+focus so you can then drop onto
// the actual window surface. Unrelated to our own icon-reorder drags.
class ExternalDragAutoActivator {
    constructor(window) {
        this._window = window;
        this._timeoutId = null;
        this._lastHoverTime = 0;
    }

    notifyDragOver() {
        this._lastHoverTime = GLib.get_monotonic_time();
        if (this._timeoutId)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._timeoutId = null;
            const elapsedMs = (GLib.get_monotonic_time() - this._lastHoverTime) / 1000;
            if (elapsedMs > 500)
                return GLib.SOURCE_REMOVE;
            this._activateWindow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _activateWindow() {
        if (!this._window) return;
        const win = this._window;
        if (win.minimized) win.unminimize();
        win.get_workspace().activate_with_focus(win, global.get_current_time());
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }
}

// ==================== WINDOW ICON RENDERER ====================
// Builds/refreshes the icon texture for one WindowIconButton, and keeps
// the compositor informed of the icon's on-screen geometry (for taskbar
// minimize animations). Icon resolution itself lives in
// windowIconTexture.js, shared with the search overlay.
class WindowIconRenderer {
    constructor(parentActor, window, settings) {
        this._parent = parentActor;
        this._window = window;
        this._settings = settings;
        this._iconSize = settings.get_int('icon-size');

        this._updateIcon();
        this._wmClassChangedId = this._window.connect('notify::wm-class', this._updateIcon.bind(this));
        this._mappedId = this._window.connect('notify::mapped', this._updateIcon.bind(this));
    }

    setIconSize(size) {
        if (size !== this._iconSize) {
            this._iconSize = size;
            this._updateIcon();
        }
    }

    _updateIcon() {
        const iconActor = createWindowIconTexture(this._window, this._iconSize);
        this._parent.set_child(iconActor);

        const signalId = iconActor.connect('stage-views-changed', () => {
            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = iconActor.get_transformed_position();
            [rect.width, rect.height] = iconActor.get_transformed_size();
            this._window.set_icon_geometry(rect);
            iconActor.disconnect(signalId);
        });
    }

    destroy() {
        if (this._wmClassChangedId) {
            this._window.disconnect(this._wmClassChangedId);
            this._wmClassChangedId = null;
        }
        if (this._mappedId) {
            this._window.disconnect(this._mappedId);
            this._mappedId = null;
        }
    }
}

// ==================== WINDOW ACTION MENU ====================
// Right-click context menu for a single window icon.
class WindowActionMenu {
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

        const menu = new PopupMenu.PopupMenu(this._anchor, 0.0, St.Side.TOP);
        menu.box.add_style_class_name('workspace-context-menu');
        this._menu = menu;
        this._menuManager = new PopupMenu.PopupMenuManager(this._anchor);
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        const win = this._window;
        menu.addAction(`Activate ${win.title}`, () => {
            win.get_workspace().activate_with_focus(win, 0);
        });

        menu.addAction(`Close ${win.title}`, () => {
            win.delete(0);
        });

        menu.addAction(`Close Except ${win.title}`, () => {
            const targetWmClass = win.get_wm_class();
            const windowsToClose = Display.get_tab_list(Meta.TabList.NORMAL, win.get_workspace())
                .filter(w => w !== win && w.get_wm_class() === targetWmClass && w.get_wm_class_instance() !== 'file_progress');
            const currentTime = global.get_current_time();
            for (const window of windowsToClose)
                window.delete(currentTime);
        });

        const app = getWindowApp(win);
        if (app) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Pin/unpin — same AppFavorites toggle gdmenu's DrunMode uses,
            // applied to the app this window belongs to.
            const favorites = AppFavorites.getAppFavorites();
            const isFav = favorites.isFavorite(app.get_id());
            menu.addAction(isFav ? `Unpin ${app.get_name()}` : `Pin ${app.get_name()}`, () => {
                if (isFav)
                    favorites.removeFavorite(app.get_id());
                else
                    favorites.addFavorite(app.get_id());
            });

            const appInfo = app.get_app_info();
            const actions = appInfo?.list_actions();
            if (actions && actions.length > 0) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                actions.forEach(action => {
                    menu.addAction(`${appInfo.get_action_name(action)}`, () => {
                        app.launch_action(action, 0, -1);
                    });
                });
            }
        }

        menu.open(true);
        if (menu._boxPointer)
            menu._boxPointer.translation_y = -35;
    }

    close() {
        if (this._menu) {
            this._menu.close();
            this._menu = null;
            this._menuManager = null;
        }
    }

    destroy() {
        this.close();
    }
}

// ==================== WINDOW HOVER PREVIEW ====================
class WindowHoverPreview {
    constructor(anchorActor, window, settings, { onHoverChange } = {}) {
        this._anchor = anchorActor;
        this._window = window;
        this._settings = settings;
        this._onHoverChange = onHoverChange ?? (() => { });
        this._previewActor = null;
        this._isShowing = false;
    }

    isShowing() { return this._isShowing; }
    isHovered() { return this._previewActor?.hover ?? false; }

    show() {
        if (this._isShowing)
            return;

        const previewHeight = this._settings.get_int('hover-preview-height');
        const built = createClonePreviewActor(this._window, previewHeight, {
            wrapperStyleClass: 'hover-preview-wrapper',
            showTitle: false,
            onClose: win => { win.delete(global.get_current_time()); this.hide(); },
            closeButtonSize: this._settings.get_int('close-button-size'),
            closeButtonOffsetX: 60,
            closeButtonOffsetY: 10,
            onHoverChange: isHovered => this._onHoverChange(isHovered),
            onActivate: () => {
                this._window.get_workspace().activate_with_focus(this._window, 0);
                this.hide();
            },
        });
        if (!built) return;

        const anchorWidth = this._anchor.get_width();
        const [anchorX] = this._anchor.get_transformed_position();
        const previewX = Math.max(0, anchorX + (anchorWidth - built.width) / 2);
        const { screenHeight } = getScreenDims();
        const previewY = screenHeight - previewHeight - 200 + 55;

        built.actor.set_position(previewX, previewY);
        this._previewActor = built.actor;
        Main.layoutManager.addChrome(this._previewActor);

        fadeInActor(this._previewActor);
        this._isShowing = true;
    }

    hide() {
        if (!this._isShowing) return;
        if (this._previewActor) {
            const actor = this._previewActor;
            this._previewActor = null;
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._isShowing = false;
    }

    destroy() { this.hide(); }
}

// ==================== WINDOW TITLE POPUP ====================
class WindowTitlePopup {
    constructor(anchorActor, window, settings, { onHoverChange } = {}) {
        this._anchor = anchorActor;
        this._window = window;
        this._settings = settings;
        this._onHoverChange = onHoverChange ?? (() => { });
        this._popupActor = null;
        this._isShowing = false;
        this._hoverSignalId = null;
    }

    isShowing() { return this._isShowing; }
    isHovered() { return this._popupActor?.hover ?? false; }

    show() {
        if (this._isShowing) return;

        const { screenWidth, screenHeight } = getScreenDims();
        const title = this._window.get_title() || 'Untitled Window';
        const label = new St.Label({ text: title, style_class: 'hover-title-popup', reactive: true, track_hover: true });
        label.set_style(`font-size: ${this._settings.get_int('title-popup-font-size')}pt;`);

        Main.layoutManager.addChrome(label);

        const [iconX] = this._anchor.get_transformed_position();
        const iconWidth = this._anchor.width;
        const padding = 10;
        const maxWidth = screenWidth - (2 * padding);
        const labelWidth = Math.min(label.width, maxWidth);
        let labelX = iconX + (iconWidth - labelWidth) / 2;
        labelX = Math.max(padding, Math.min(labelX, screenWidth - labelWidth - padding));

        label.set_position(labelX, screenHeight - 200);
        this._popupActor = label;

        fadeInActor(label);
        this._hoverSignalId = label.connect('notify::hover', () => this._onHoverChange(label.hover));
        this._isShowing = true;
    }

    hide() {
        if (!this._isShowing) return;
        if (this._popupActor) {
            const actor = this._popupActor;
            this._popupActor = null;
            if (this._hoverSignalId) { actor.disconnect(this._hoverSignalId); this._hoverSignalId = null; }
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._isShowing = false;
    }

    destroy() { this.hide(); }
}

function getScreenDims() {
    return { screenWidth: global.get_screen_width(), screenHeight: global.get_screen_height() };
}

// ==================== WINDOW ICON BUTTON ====================
export class WindowIconButton extends St.Button {
    static {
        GObject.registerClass(this);
    }

    static _liveCount = 0;

    constructor(window, settings) {
        super({ style_class: 'window-preview-icon', reactive: true, track_hover: true });

        WindowIconButton._liveCount++;
        journal(`[WindowIconButton] +constructed for "${window.title}" (live: ${WindowIconButton._liveCount})`);

        this._window = window;
        this._settings = settings;
        this.icon_size = settings.get_int('icon-size');

        this._iconRenderer = new WindowIconRenderer(this, window, settings);
        this._actionMenu = new WindowActionMenu(window, this);
        this._hoverPreview = new WindowHoverPreview(this, window, settings, { onHoverChange: h => this._onPreviewHoverChange(h) });
        this._titlePopup = new WindowTitlePopup(this, window, settings, { onHoverChange: h => this._onPreviewHoverChange(h) });
        this._dragActivator = new ExternalDragAutoActivator(window);

        this._cleanupTimeoutId = null;
        this._hoverTimeoutId = null;

        this._delegate = this;
        this._draggable = DND.makeDraggable(this, { restoreOnSuccess: false });

        this._draggable.connect('drag-begin', () => WindowReorderDragController.beginDrag(this, this._window));
        this._draggable.connect('drag-end', () => WindowReorderDragController.endDrag());

        this._hoverSignalId = this.connect('notify::hover', () => this._onIconHoverChange());
        this._buttonPressedId = this.connect('button-press-event', this._onButtonPressed.bind(this));

        this._wsChangedId = WorkspaceManager.connect('workspace-switched', () => {
            this.forceHidePreview('workspace switched');
            this._actionMenu.close();
        });
    }

    get window() { return this._window; }
    get realWindow() { return this._window.get_compositor_private(); }

    // GNOME Shell's DND implementation destroys the drag actor after a
    // successful drop when restoreOnSuccess is false. The canonical
    // WindowIconButton must therefore NEVER be the drag actor. Return a
    // disposable visual proxy instead; the real button stays owned by the
    // ThumbnailDisplayModeController and is leased by the drag controller.
    getDragActor() {
        const source = this.get_child();
        if (!source)
            return new St.Bin({ width: this.width, height: this.height });

        const proxy = new St.Bin({
            width: this.width,
            height: this.height,
            reactive: false,
            style_class: 'window-preview-icon',
        });
        proxy.set_child(new Clutter.Clone({ source }));
        proxy.icon_size = this.icon_size;
        return proxy;
    }

    // Keep the canonical source available to GNOME Shell for drag-source
    // positioning. The returned actor is NOT destroyed by DND; only the
    // proxy from getDragActor() is disposable.
    getDragActorSource() {
        return this;
    }

    onCtrlChanged(ctrlPressed) {
        if (ctrlPressed) { this._titlePopup.show(); this._hoverPreview.hide(); }
        else { this._hoverPreview.show(); this._titlePopup.hide(); }
    }

    forceHidePreview(reason = '') {
        this._cancelCleanup();
        ActivePreviewTracker.unregisterPreview(this);
        this._hoverPreview.hide();
        this._titlePopup.hide();
    }

    setIconSize(size) {
        this.icon_size = size;
        this._iconRenderer.setIconSize(size);
    }

    _getThumbnail() {
        const box = this.get_parent();
        return box ? box.get_parent() : null;
    }

    _onIconHoverChange() {
        if (this._hoverTimeoutId) { GLib.source_remove(this._hoverTimeoutId); this._hoverTimeoutId = null; }
        if (this.hover) {
            this._cancelCleanup();
            if (this._hoverPreview.isShowing() || this._titlePopup.isShowing()) {
                this.onCtrlChanged(ActivePreviewTracker.getCurrentCtrlState());
                return;
            }
            // 30ms debounce — avoids flashing a preview when the pointer
            // merely passes through on its way somewhere else.
            this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                this._hoverTimeoutId = null;
                ActivePreviewTracker.registerPreview(this);
                this._showPreview();
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._hoverPreview.isShowing() || this._titlePopup.isShowing()) {
            this._startCleanup();
        }
    }

    _onPreviewHoverChange(isHovered) {
        if (isHovered) this._cancelCleanup();
        else if (!this.hover) this._startCleanup();
    }

    _showPreview() {
        const shouldShow = this.hover || this._hoverPreview.isShowing() || this._titlePopup.isShowing();
        if (!shouldShow) return;
        if (ActivePreviewTracker.getCurrentCtrlState()) this._titlePopup.show();
        else this._hoverPreview.show();
    }

    _startCleanup() {
        this._stopCleanupTimer();
        // TimeoutDelay grace period — lets the pointer cross the small gap
        // between the icon and its preview without the preview vanishing.
        this._cleanupTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
            this._cleanupTimeoutId = null;
            const stillHovering = this.hover || this._hoverPreview.isHovered() || this._titlePopup.isHovered();
            if (stillHovering) return GLib.SOURCE_REMOVE;
            ActivePreviewTracker.unregisterPreview(this);
            this._hoverPreview.hide();
            this._titlePopup.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelCleanup() { this._stopCleanupTimer(); }
    _stopCleanupTimer() {
        if (this._cleanupTimeoutId) { GLib.source_remove(this._cleanupTimeoutId); this._cleanupTimeoutId = null; }
    }

    handleDragOver(source, actor, x, y, time) {
        journal(`[WindowIconButton] handleDragOver from ${source.constructor.name}`);
        if (source instanceof WindowIconButton) {
            const thumbnail = this._getThumbnail();
            if (thumbnail?.handleWindowDragOver)
                return thumbnail.handleWindowDragOver(source._window, this, x, y, time);
            return DND.DragMotionResult.CONTINUE;
        }
        this._dragActivator.notifyDragOver();
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, actor, x, y, time) {
        journal(`[WindowIconButton] acceptDrop from ${source.constructor.name}`);
        if (source instanceof WindowIconButton) {
            const thumbnail = this._getThumbnail();
            if (thumbnail?.acceptWindowDrop)
                return thumbnail.acceptWindowDrop(source._window, this, x, y, time);
            return false;
        }
        return false;
    }

    _onButtonPressed(actor, event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_PRIMARY) {
            this.forceHidePreview('left click');
            const win = this._window;
            const currentWs = WorkspaceManager.get_active_workspace();
            const winWs = win.get_workspace();
            if (winWs === currentWs) {
                if (win.minimized) { win.unminimize(); win.activate_with_workspace(0, winWs); }
                else if (this._isCovered(win)) win.activate_with_workspace(0, winWs);
                else win.minimize();
                return Clutter.EVENT_STOP;
            }
            winWs.activate_with_focus(win, 0);
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_SECONDARY) {
            this.forceHidePreview('right click');
            this._actionMenu.open();
            return Clutter.EVENT_STOP;
        }
    }

    _isCovered(window) {
        if (window.minimized) return false;
        const currentWorkspace = WorkspaceManager.get_active_workspace();
        const windowsByStacking = Display.sort_windows_by_stacking(
            Display.list_all_windows().filter(win =>
                (win.get_window_type() === Meta.WindowType.NORMAL || win.get_window_type() === Meta.WindowType.DIALOG) &&
                win.get_workspace() === currentWorkspace));
        const targetRect = window.get_frame_rect();
        const targetIndex = windowsByStacking.indexOf(window);
        for (let i = targetIndex + 1; i < windowsByStacking.length; i++) {
            const topRect = windowsByStacking[i].get_frame_rect();
            if (topRect.x <= targetRect.x && topRect.y <= targetRect.y &&
                topRect.x + topRect.width >= targetRect.x + targetRect.width &&
                topRect.y + topRect.height >= targetRect.y + targetRect.height)
                return true;
        }
        return false;
    }

    destroy() {
        journal(`[WindowIconButton] destroying "${this._window.title}" (live before: ${WindowIconButton._liveCount})`);

        try {
            throw new Error('Destroy stack trace');
        } catch (e) {
            journal(`[WindowIconButton] destroy stack: ${e.stack}`);
        }

        WindowReorderDragController.clearIfRelated(this);
        this.forceHidePreview('destroy');

        if (this._hoverSignalId) { this.disconnect(this._hoverSignalId); this._hoverSignalId = null; }
        if (this._buttonPressedId) { this.disconnect(this._buttonPressedId); this._buttonPressedId = null; }
        if (this._wsChangedId) { WorkspaceManager.disconnect(this._wsChangedId); this._wsChangedId = null; }
        if (this._hoverTimeoutId) { GLib.source_remove(this._hoverTimeoutId); this._hoverTimeoutId = null; }

        this._iconRenderer.destroy();
        this._actionMenu.destroy();
        this._hoverPreview.destroy();
        this._titlePopup.destroy();
        this._dragActivator.destroy();

        if (this.get_child()) this.set_child(null);

        super.destroy();

        WindowIconButton._liveCount--;
        journal(`[WindowIconButton] -destroyed (live: ${WindowIconButton._liveCount})`);
    }
}
