import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { WorkspaceManager, Display, TimeoutDelay } from './shellGlobals.js';
import { journal } from '../utils.js';
import { WindowIconRenderer } from './windowIconRenderer.js';
import { WindowActionMenu } from './windowActionMenu.js';
import { WindowHoverPreview } from './windowHoverPreview.js';
import { WindowTitlePopup } from './windowTitlePopup.js';
import { ExternalDragAutoActivator } from './externalDragAutoActivator.js';
import { ActivePreviewTracker } from './activePreviewTracker.js';
import { WindowReorderDragController } from './windowReorderDragController.js';

// ==================== WINDOW ICON BUTTON (coordinator) ====================
// The clickable icon representing one window inside a WorkspaceThumbnail.
// This class owns only: the St.Button itself, click routing, and DND
// source wiring for reordering. Every other concern (icon rendering,
// context menu, hover preview, title popup, external-drag activation) is
// delegated to a dedicated collaborator held as a field — change any one
// of those without touching this class.
export class WindowIconButton extends St.Button {
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

        this._iconRenderer = new WindowIconRenderer(this, window);
        this._actionMenu = new WindowActionMenu(window, this);
        this._hoverPreview = new WindowHoverPreview(this, window, {
            onHoverChange: isHovered => this._onPreviewHoverChange(isHovered),
        });
        this._titlePopup = new WindowTitlePopup(this, window, {
            onHoverChange: isHovered => this._onPreviewHoverChange(isHovered),
        });
        this._dragActivator = new ExternalDragAutoActivator(window);

        this._cleanupTimeoutId = null;
        this._hoverTimeoutId = null;

        // DND setup
        this._delegate = this;
        this._draggable = DND.makeDraggable(this, { restoreOnSuccess: true });
        journal(`[WindowIconButton] DND draggable created for ${window.title}`);

        this._draggable.connect('drag-begin', () => {
            journal(`[WindowIconButton] Drag began for ${this._window.title}`);
            WindowReorderDragController.beginDrag(this);
        });

        this._draggable.connect('drag-end', () => {
            journal(`[WindowIconButton] Drag ended for ${this._window.title}`);
            WindowReorderDragController.endDrag();

            const thumbnail = this._getThumbnail();
            if (thumbnail?.syncChildOrder) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
                    thumbnail.syncChildOrder?.();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        this._hoverSignalId = this.connect('notify::hover', () => {
            journal(`[WindowIconButton] Icon hover changed: ${this.hover}`);
            this._onIconHoverChange();
        });

        this._buttonPressedId = this.connect('button-press-event',
            this._onButtonPressed.bind(this));

        this._wsChangedId = WorkspaceManager.connect('workspace-switched', () => {
            journal(`[WindowIconButton] Workspace switched`);
            this.forceHidePreview('workspace switched');
            this._actionMenu.close();
        });
    }

    // ---- public surface used by collaborators (ActivePreviewTracker, WorkspaceThumbnail) ----
    get window() {
        return this._window;
    }

    get realWindow() {
        return this._window.get_compositor_private();
    }

    onCtrlChanged(ctrlPressed) {
        journal(`[WindowIconButton] Ctrl changed: ${ctrlPressed}`);
        if (ctrlPressed) {
            this._titlePopup.show();
            this._hoverPreview.hide();
        } else {
            this._hoverPreview.show();
            this._titlePopup.hide();
        }
    }

    forceHidePreview(reason = '') {
        journal(`[WindowIconButton] Force hiding preview${reason ? `: ${reason}` : ''}`);
        this._cancelCleanup();
        ActivePreviewTracker.unregisterPreview(this);
        this._hoverPreview.hide();
        this._titlePopup.hide();
    }

    setIconSize(size) {
        this.icon_size = size;
        this._iconRenderer.setIconSize(size);
    }

    // ---- internal ----
    _getThumbnail() {
        const box = this.get_parent();
        return box ? box.get_parent() : null;
    }

    _onIconHoverChange() {
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }
        if (this.hover) {
            this._cancelCleanup();
            if (this._hoverPreview.isShowing() || this._titlePopup.isShowing()) {
                journal(`[WindowIconButton] Already showing preview, re-syncing to current Ctrl state`);
                // show()/hide() on both collaborators are no-ops when
                // already in the right state, so this is safe to call
                // redundantly and won't rebuild anything.
                this.onCtrlChanged(ActivePreviewTracker.getCurrentCtrlState());
                return;
            }
            this._hoverTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                30,
                () => {
                    this._hoverTimeoutId = null;
                    ActivePreviewTracker.registerPreview(this);
                    this._showPreview();
                    return GLib.SOURCE_REMOVE;
                }
            );
        } else if (this._hoverPreview.isShowing() || this._titlePopup.isShowing()) {
            this._startCleanup();
        }
    }

    _onPreviewHoverChange(isHovered) {
        journal(`[WindowIconButton] Preview hover changed: ${isHovered}, icon hover: ${this.hover}`);
        if (isHovered)
            this._cancelCleanup();
        else if (!this.hover)
            this._startCleanup();
    }

    _showPreview() {
        const shouldShow = this.hover || this._hoverPreview.isShowing() || this._titlePopup.isShowing();
        if (!shouldShow) {
            journal(`[WindowIconButton] Not hovering anymore, aborting`);
            return;
        }
        if (ActivePreviewTracker.getCurrentCtrlState())
            this._titlePopup.show();
        else
            this._hoverPreview.show();
    }

    _startCleanup() {
        this._stopCleanupTimer();
        journal(`[WindowIconButton] Starting cleanup timer`);
        this._cleanupTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TimeoutDelay,
            () => {
                this._cleanupTimeoutId = null;
                const stillHovering = this.hover ||
                    this._hoverPreview.isHovered() ||
                    this._titlePopup.isHovered();
                if (stillHovering) {
                    journal(`[WindowIconButton] Cleanup aborted - still hovering`);
                    return GLib.SOURCE_REMOVE;
                }
                journal(`[WindowIconButton] Cleanup timer completed`);
                ActivePreviewTracker.unregisterPreview(this);
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
            GLib.source_remove(this._cleanupTimeoutId);
            this._cleanupTimeoutId = null;
        }
    }

    // ==================== DND (external drag hover-to-activate) ====================
    handleDragOver(source, actor, x, y, time) {
        journal(`[WindowIconButton] handleDragOver source=${source?.constructor?.name}, window=${this._window?.title}`);

        // Our own reorder drags: route to the parent WorkspaceThumbnail so
        // it can compute the before/after insertion using its stabilized
        // snapshot-based math.
        if (source instanceof WindowIconButton) {
            const draggedWindow = source._window;
            const thumbnail = this._getThumbnail();

            if (thumbnail?.handleWindowDragOver)
                return thumbnail.handleWindowDragOver(draggedWindow, this, x, y, time);

            return DND.DragMotionResult.CONTINUE;
        }

        // External drag (files, text, tabs, etc.).
        this._dragActivator.notifyDragOver();
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, actor, x, y, time) {
        journal(`[WindowIconButton] acceptDrop source=${source?.constructor?.name}`);

        if (source instanceof WindowIconButton) {
            const draggedWindow = source._window;
            const thumbnail = this._getThumbnail();
            if (thumbnail?.acceptWindowDrop)
                return thumbnail.acceptWindowDrop(draggedWindow, this, x, y, time);
            return false;
        }

        return false;
    }

    // ==================== EVENT HANDLERS ====================
    _onButtonPressed(actor, event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_PRIMARY) {
            journal(`[WindowIconButton] Left click`);
            this.forceHidePreview('left click');
            const win = this._window;
            const currentWs = WorkspaceManager.get_active_workspace();
            const winWs = win.get_workspace();
            if (winWs === currentWs) {
                if (win.minimized) {
                    win.unminimize();
                    win.activate_with_workspace(0, winWs);
                } else if (this._isCovered(win)) {
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
            journal(`[WindowIconButton] Right click`);
            this.forceHidePreview('right click');
            this._actionMenu.open();
            return Clutter.EVENT_STOP;
        }
    }

    _isCovered(window) {
        if (window.minimized) return false;
        const currentWorkspace = WorkspaceManager.get_active_workspace();
        const windowsByStacking = Display.sort_windows_by_stacking(
            Display.list_all_windows()
                .filter(win =>
                    (win.get_window_type() === Meta.WindowType.NORMAL ||
                        win.get_window_type() === Meta.WindowType.DIALOG) &&
                    win.get_workspace() === currentWorkspace)
        );
        const targetRect = window.get_frame_rect();
        const targetIndex = windowsByStacking.indexOf(window);
        for (let i = targetIndex + 1; i < windowsByStacking.length; i++) {
            const topRect = windowsByStacking[i].get_frame_rect();
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

    destroy() {
        journal(`[WindowIconButton] Destroying`);
        WindowReorderDragController.clearIfRelated(this);
        this.forceHidePreview('destroy');

        if (this._hoverSignalId) {
            this.disconnect(this._hoverSignalId);
            this._hoverSignalId = null;
        }
        if (this._buttonPressedId) {
            this.disconnect(this._buttonPressedId);
            this._buttonPressedId = null;
        }
        if (this._wsChangedId) {
            WorkspaceManager.disconnect(this._wsChangedId);
            this._wsChangedId = null;
        }
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        this._iconRenderer.destroy();
        this._actionMenu.destroy();
        this._hoverPreview.destroy();
        this._titlePopup.destroy();
        this._dragActivator.destroy();

        if (this.get_child())
            this.set_child(null);

        super.destroy();
        journal(`[WindowIconButton] Destroyed`);
    }
}