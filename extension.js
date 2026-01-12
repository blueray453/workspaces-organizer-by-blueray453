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

import { setLogging, setLogFn, journal } from './utils.js'

const WorkspaceManager = global.get_workspace_manager();
const WindowTracker = global.get_window_tracker();
const Display = global.get_display();
const TimeoutDelay = 200;

// ==================== PREVIEW REGISTRY WITH CTRL POLLING ====================

// PreviewRegistry is a singleton manager
// centralized manager for the currently active window preview and CTRL-key polling
// It acts like a singleton registry + mediator specifically for hover previews.
// Only one preview can be “active” at a time.
// This polling only runs while there is an active preview.
// Polling is scoped only to when a preview is active.
// There are no dangling timers, memory leaks, or unnecessary CPU usage.
// Registry → keeps track of active preview
// Mediator → propagates CTRL - key changes to the preview
const PreviewRegistry = {
    activePreview: null,
    _ctrlPollId: null,
    _ctrlPressed: false,

    registerPreview(preview) {
        journal(`[PreviewRegistry] Registering preview for window: ${preview._window.title}`);

        // Cleanup previous active preview if different
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

    // ==================== CTRL KEY POLLING ====================

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

        // Get initial state
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

            if (GLib.Source.remove(sourceId)) {
                journal(`[PreviewRegistry] Stopped Ctrl poll`);
            }
        }
    },

    _onCtrlPollTick() {
        if (!this.activePreview) {
            journal(`[PreviewRegistry] No active preview, stopping Ctrl poll`);
            this._stopCtrlPoll();
            return GLib.SOURCE_REMOVE;
        }

        // Check for Ctrl key state change
        const [, , mods] = global.get_pointer();
        const ctrlDown = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (ctrlDown !== this._ctrlPressed) {
            this._ctrlPressed = ctrlDown;
            journal(`[PreviewRegistry] Ctrl state changed: ${this._ctrlPressed}`);

            // Notify active preview
            if (this.activePreview) {
                this.activePreview._onCtrlChanged(ctrlDown);
            }
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

// ==================== WINDOW PREVIEW CLASS ====================

class WindowPreview extends St.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(window) {
        super({
            reactive: true,
            track_hover: true,
        });

        this._window = window;
        this.icon_size = 96;

        // UI elements
        this._hoverPreview = null;
        this._titlePopup = null;
        this._contextMenu = null;

        // Timers
        this._cleanupTimeoutId = null;
        this._hoverTimeoutId = null;

        // DND setup
        this._delegate = this;
        DND.makeDraggable(this, { restoreOnSuccess: true });

        // Initialize icon
        this._updateIcon();

        // Connect window signals
        this._wmClassChangedId = this._window.connect('notify::wm-class',
            this._updateIcon.bind(this));
        this._mappedId = this._window.connect('notify::mapped',
            this._updateIcon.bind(this));

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
                this._contextMenu = null;
            }
        });
    }

    // ==================== HOVER MANAGEMENT ====================

    _onIconHoverChange() {
        // Clear existing hover timeout
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        if (this.hover) {
            // Mouse entered icon
            this._cancelCleanup();

            // If already showing preview, handle immediately
            if (this._isShowingPreview()) {
                journal(`[WindowPreview] Already showing preview, updating immediately`);
                this._updatePreview();
                return;
            }

            // Debounce initial hover
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
            // Mouse left icon
            if (this._isShowingPreview()) {
                this._startCleanup();
            }
        }
    }

    _onPreviewHoverChange(isHovered) {
        journal(`[WindowPreview] Preview hover changed: ${isHovered}, icon hover: ${this.hover}`);

        if (isHovered) {
            // Mouse entered preview
            this._cancelCleanup();
        } else {
            // Mouse left preview
            if (!this.hover) {
                this._startCleanup();
            }
        }
    }

    // ==================== CTRL CHANGE CALLBACK ====================

    _onCtrlChanged(ctrlPressed) {
        journal(`[WindowPreview] Ctrl changed: ${ctrlPressed}`);

        if (ctrlPressed) {
            this._showTitlePopup();
        } else {
            this._showHoverPreview();
        }
    }

    // ==================== PREVIEW DISPLAY ====================

    _showPreview() {
        if (!this._window) {
            journal(`[WindowPreview] No window available`);
            return;
        }

        // Check if still hovering or already showing
        const shouldShow = this.hover || this._isShowingPreview();
        if (!shouldShow) {
            journal(`[WindowPreview] Not hovering anymore, aborting`);
            return;
        }

        const ctrlPressed = PreviewRegistry.getCurrentCtrlState();

        if (ctrlPressed) {
            this._showTitlePopup();
        } else {
            this._showHoverPreview();
        }
    }

    _updatePreview() {
        const ctrlPressed = PreviewRegistry.getCurrentCtrlState();

        if (ctrlPressed && !this._titlePopup) {
            this._showTitlePopup();
        } else if (!ctrlPressed && !this._hoverPreview) {
            this._showHoverPreview();
        }
    }

    _showHoverPreview() {
        journal(`[WindowPreview] Showing hover preview`);

        if (!this._window) return;

        // Hide title popup if showing
        this._hideTitlePopup();

        // Don't recreate if already exists
        if (this._hoverPreview) {
            journal(`[WindowPreview] Preview already exists`);
            return;
        }

        // Check if we should still show - either hovering or cleanup timer running
        const shouldShow = this.hover ||
            this._cleanupTimeoutId !== null ||
            (this._hoverPreview !== null || this._titlePopup !== null);

        if (!shouldShow) {
            journal(`[WindowPreview] Not hovering and no cleanup pending, aborting`);
            return;
        }

        // Clone window for preview
        const windowPreviewWidth = this.get_width();
        const [windowPreviewX, windowPreviewY] = this.get_transformed_position();
        const windowFrame = this._window.get_frame_rect();

        const previewHeight = 800;
        const previewWidth = previewHeight * (windowFrame.width / windowFrame.height);

        let previewX = Math.max(0, windowPreviewX + (windowPreviewWidth - previewWidth) / 2);
        const previewY = windowPreviewY - previewHeight - 64;

        const bufferFrame = this._window.get_buffer_rect();
        const scale = previewHeight / windowFrame.height;

        const scaledLeftShadow = (windowFrame.x - bufferFrame.x) * scale;
        const scaledTopShadow = (windowFrame.y - bufferFrame.y) * scale;
        const scaledRightShadow = ((bufferFrame.x + bufferFrame.width) - (windowFrame.x + windowFrame.width)) * scale;
        const scaledBottomShadow = ((bufferFrame.y + bufferFrame.height) - (windowFrame.y + windowFrame.height)) * scale;

        // Create preview hierarchy
        const outerWrapper = new St.BoxLayout({
            style_class: 'hover-preview-wrapper',
            x: previewX,
            y: previewY,
            reactive: true,
            track_hover: true,
        });

        // `clip_to_allocation: true` makes the container act like a mask.
        // anything outside innerContainer is cut off.
        // Shadows are cropped correctly
        // Think of it like a photo frame:
        // outerWrapper → the frame(border, visible around the picture)
        // innerContainer → the glass / mask inside the frame
        // clone → the photo inside, which may have a little overhang(shadows)
        // The glass cuts off anything sticking out, but the frame is always visible.
        //
        const innerContainer = new St.BoxLayout({
            style_class: 'hover-preview-inner',
            width: previewWidth,
            height: previewHeight,
            clip_to_allocation: true,
        });

        const windowActor = this._window.get_compositor_private();
        const clone = new Clutter.Clone({
            source: windowActor,
            width: previewWidth + scaledLeftShadow + scaledRightShadow,
            height: previewHeight + scaledTopShadow + scaledBottomShadow,
        });

        clone.set_position(-scaledLeftShadow, -scaledTopShadow);

        // Close button
        const closeButton = new St.Button({
            style_class: 'window-close-button',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 48,
            }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            reactive: true,
        });

        closeButton.set_position(previewWidth - 60, 10);
        closeButton.connect('clicked', () => {
            this._window.delete(global.get_current_time());
            this._forceHide('close button clicked');
            return Clutter.EVENT_STOP;
        });

        // BUILD HIERARCHY
        // The cloneContainer might seem redundant at first
        // The cloneContainer acts as a positioning canvas
        // Gives you a reliable coordinate system for precise positioning
        // Keeps the clone's negative positioning from affecting the clipped container
        const cloneContainer = new Clutter.Actor();
        cloneContainer.add_child(clone);
        cloneContainer.add_child(closeButton);
        innerContainer.add_child(cloneContainer);
        outerWrapper.add_child(innerContainer);

        this._hoverPreview = outerWrapper;
        Main.layoutManager.addChrome(this._hoverPreview);

        this._hoverPreview.opacity = 0;
        this._hoverPreview.ease({
            opacity: 255,
            duration: TimeoutDelay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Event handlers
        outerWrapper.connect('notify::hover', () => {
            this._onPreviewHoverChange(outerWrapper.hover);
        });

        outerWrapper.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._window.get_workspace().activate_with_focus(this._window, 0);
                this._forceHide('preview clicked');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        journal(`[WindowPreview] Hover preview shown`);
    }

    // _showTitlePopup() is a fallback hover UI.

    // When you hover a window preview while holding Ctrl,
    // instead of showing the big live window preview,
    // this function shows a small text label with the window title.

    // However it creates a bug due to the use of grab_key_focus
    // Some keybindings stop working.
    // This is why removing this feature

    _showTitlePopup() {
        journal(`[WindowPreview] Showing title popup`);

        if (!this._window) return;

        // Hide hover preview if showing
        this._hideHoverPreview();

        // Don't recreate if already exists
        if (this._titlePopup) {
            journal(`[WindowPreview] Title popup already exists`);
            return;
        }

        // Check if we should still show - either hovering or cleanup timer running
        const shouldShow = this.hover ||
            this._cleanupTimeoutId !== null ||
            (this._hoverPreview !== null || this._titlePopup !== null);

        if (!shouldShow) {
            journal(`[WindowPreview] Not hovering and no cleanup pending, aborting`);
            return;
        }

        let [labelX, labelY] = this.get_transformed_position();
        const title = this._window.get_title() || "Untitled Window";

        const label = new St.Label({
            text: title,
            style_class: "hover-title-popup",
            reactive: true,
            track_hover: true,
        });

        labelX = Math.max(0, labelX);
        labelY = labelY - 105;
        label.set_position(labelX, labelY);

        this._titlePopup = label;
        Main.layoutManager.addChrome(label);

        label.opacity = 0;
        label.ease({
            opacity: 255,
            duration: TimeoutDelay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        label.connect("notify::hover", () => {
            this._onPreviewHoverChange(label.hover);
        });

        journal(`[WindowPreview] Title popup shown`);
    }

    _hideHoverPreview() {
        if (!this._hoverPreview) return;

        journal(`[WindowPreview] Hiding hover preview`);
        const wrapper = this._hoverPreview;
        this._hoverPreview = null;

        Main.layoutManager.removeChrome(wrapper);
        wrapper.destroy();
    }

    _hideTitlePopup() {
        if (!this._titlePopup) return;

        journal(`[WindowPreview] Hiding title popup`);
        const popup = this._titlePopup;
        this._titlePopup = null;

        Main.layoutManager.removeChrome(popup);
        popup.destroy();
    }

    _hideAll() {
        journal(`[WindowPreview] Hiding all previews`);
        this._hideHoverPreview();
        this._hideTitlePopup();
    }

    _forceHide(reason = '') {
        journal(`[WindowPreview] Force hiding${reason ? `: ${reason}` : ''}`);

        // Cancel cleanup timer first to prevent it from firing after unregister
        this._cancelCleanup();

        // Unregister from registry (stops Ctrl polling)
        PreviewRegistry.unregisterPreview(this);

        // Hide all UI
        this._hideAll();
    }

    _isShowingPreview() {
        return this._hoverPreview !== null || this._titlePopup !== null;
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

                // Check if still not hovering
                const iconHovered = this.hover;
                const previewHovered = this._hoverPreview?.hover || false;
                const titleHovered = this._titlePopup?.hover || false;

                if (iconHovered || previewHovered || titleHovered) {
                    journal(`[WindowPreview] Cleanup aborted - still hovering`);
                    return GLib.SOURCE_REMOVE;
                }

                // Proceed with cleanup
                journal(`[WindowPreview] Cleanup timer completed`);

                // Unregister first to stop Ctrl polling
                PreviewRegistry.unregisterPreview(this);

                // Then hide all UI
                this._hideAll();

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
            this._showContextMenu();
            return Clutter.EVENT_STOP;
        }
    }

    // ==================== CONTEXT MENU ====================

    _showContextMenu() {
        let menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP);

        // menu - This is the PopupMenu JavaScript object.
        // It's not a visual actor itself
        // menu.box - This is the actual St.BoxLayout actor
        // PopupMenu(JavaScript object)
        // ├─ actor(St.Widget - the outer container)
        // └─ box(St.BoxLayout - contains the menu items)
        //     ├─ PopupMenuItem 1
        //     ├─ PopupMenuItem 2
                //     └─ ...

        menu.box.add_style_class_name('workspace-context-menu');
        this._contextMenu = menu;

        let manager = new PopupMenu.PopupMenuManager(this);
        manager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        menu.addAction(`Activate ${this._window.title}`, () => {
            let win_workspace = this._window.get_workspace();
            win_workspace.activate_with_focus(this._window, 0);
        });

        menu.addAction(`Close ${this._window.title}`, () => {
            this._window.delete(0);
        });

        // Add desktop actions
        const app = WindowTracker.get_window_app(this._window);
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

        if (menu._boxPointer) {
            menu._boxPointer.translation_y = -35;
        }
    }

    // ==================== UTILITY METHODS ====================

    _is_covered(window) {
        if (window.minimized) { return false; }
        let current_workspace = WorkspaceManager.get_active_workspace();

        let windows_by_stacking = Display.sort_windows_by_stacking(
            global.get_window_actors()
                .map(actor => actor.meta_window)
                .filter(win => win.get_window_type() === Meta.WindowType.NORMAL)
        ).filter(win => win.get_workspace() === current_workspace);

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

    _updateIcon() {
        const app = Shell.WindowTracker.get_default().get_window_app(this._window) ||
            Shell.AppSystem.get_default().lookup_app(this._window.get_wm_class());

        let iconActor = null;

        if (app && app.get_app_info().get_icon()) {
            iconActor = app.create_icon_texture(this.icon_size);
            this.set_child(iconActor);
        } else {
            let gicon = this._window.get_gicon();
            if (!gicon) {
                gicon = new Gio.ThemedIcon({ name: 'applications-system-symbolic' });
            }
            const icon = new St.Icon({
                gicon: gicon,
                style_class: 'popup-menu-icon'
            });

            iconActor = St.TextureCache.get_default().load_gicon(null, icon, this.icon_size);
            this.set_child(iconActor);
        }

        const signalId = iconActor.connect('stage-views-changed', (actor) => {
            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = iconActor.get_transformed_position();
            [rect.width, rect.height] = iconActor.get_transformed_size();
            this._window.set_icon_geometry(rect);

            iconActor.disconnect(signalId);
        });
    }

    destroy() {
        journal(`[WindowPreview] Destroying`);

        // Force hide to clean up everything properly
        this._forceHide('destroy');

        // Disconnect signals
        if (this._hoverSignalId) {
            this.disconnect(this._hoverSignalId);
            this._hoverSignalId = null;
        }

        if (this._wmClassChangedId && this._window) {
            this._window.disconnect(this._wmClassChangedId);
            this._wmClassChangedId = null;
        }

        if (this._mappedId && this._window) {
            this._window.disconnect(this._mappedId);
            this._mappedId = null;
        }

        if (this._buttonPressedId) {
            this.disconnect(this._buttonPressedId);
            this._buttonPressedId = null;
        }

        if (this._wsChangedId && WorkspaceManager) {
            WorkspaceManager.disconnect(this._wsChangedId);
            this._wsChangedId = null;
        }

        // Clear hover debounce timeout
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        // Remove children
        if (this.get_child()) {
            this.set_child(null);
        }

        super.destroy();

        journal(`[WindowPreview] Destroyed`);
    }
}

// Represents a single workspace in the panel indicator.
// Holds a set of WindowPreviews for all windows in that workspace.
// shows a context menu (e.g., close all windows).
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

        this._windowsBox = new St.BoxLayout();

        this._windowCount = 0;

        this.set_child(this._windowsBox);

        this._delegate = this; // needed for DND

        this._windowPreviews = new Map();
        this._addWindowTimeoutIds = new Map();

        this._workspace = workspace;

        this._wsChangedId = WorkspaceManager.connect('workspace-switched', () => {
            if (this._contextMenu) {
                this._contextMenu.close();
                this._contextMenu = null;
            }
        });

        this.connect('button-press-event', (actor, event) => {
            let button = event.get_button();

            if (button === Clutter.BUTTON_PRIMARY) { // left click
                this._workspace.activate(0);
            }

            if (button === Clutter.BUTTON_SECONDARY) { // right click
                let windows = this._workspace.list_windows().filter(w =>
                    w.get_window_type() === 0
                );

                const windowCount = windows.length;

                if (windowCount === 0) {
                    return Clutter.EVENT_STOP; // Fix: Return STOP to prevent menu creation
                }

                let menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP);
                menu.box.add_style_class_name('workspace-context-menu');
                this._contextMenu = menu; // keep reference

                // menu.removeAll();

                let manager = new PopupMenu.PopupMenuManager(this);
                manager.addMenu(menu);
                Main.uiGroup.add_child(menu.actor);

                menu.addAction(`Close all windows on workspace ${this._workspace.index()}`, () => {
                    windows.forEach(window => {
                        journal(`Closing window: ${window.get_title()}`);
                        window.delete(0);
                    });
                });

                menu.open(true);
            }

            return Clutter.EVENT_STOP; // prevent default

            // For left click, let the default handler work
            // return Clutter.EVENT_PROPAGATE;
        });

        this._windowAddedId = this._workspace.connect('window-added',
            (ws, window) => {
                this._addWindow(window);
            });
        this._windowRemovedId = this._workspace.connect('window-removed',
            (ws, window) => {
                this._removeWindow(window);
            });
        this._restackedId = Display.connect('restacked',
            this._onRestacked.bind(this));
        this._windowCreatedId = Display.connect('window-created',
            (display, window) => {
                if (window.get_workspace() === this._workspace) {
                    this._addWindow(window);
                }
            });

        this._workspace.list_windows().forEach(w => this._addWindow(w));
        this._onRestacked();
    }

    acceptDrop(source) {
        if (!source.realWindow)
            return false;

        let window = source.realWindow.get_meta_window();
        this._moveWindow(window);
        return true;
    }

    handleDragOver(source) {
        if (source.realWindow)
            return DND.DragMotionResult.MOVE_DROP;
        else
            return DND.DragMotionResult.CONTINUE;
    }

    _addWindow(window) {
        if (this._windowPreviews.has(window))
            return;

        // // Add immediate check for window validity
        // if (!window || window.is_override_redirect())
        //     return;

        // Skip uninteresting windows
        if (window.skip_taskbar)
            return;

        // Ensure we don't leave behind multiple timeouts for the same window
        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
            // If already created a preview for this window, stop
            if (this._windowPreviews.has(window))
                return GLib.SOURCE_REMOVE;

            if (!this._windowsBox || !this._windowsBox.get_stage())
                return GLib.SOURCE_REMOVE;

            let preview = new WindowPreview(window);
            preview.connect('clicked', () => {
                // window.activate_with_workspace(global.get_current_time(), window.get_workspace());
                this._workspace.activate(0);
                window.activate(0);
            });
            this._windowPreviews.set(window, preview);
            // Double check container is still valid  before adding
            if (this._windowsBox && this._windowsBox.get_stage())
                this._windowsBox.add_child(preview);
            else
                preview.destroy();

            this._windowCount++;
            this._updateThumbnailSize();

            this._addWindowTimeoutIds.delete(window);
            return GLib.SOURCE_REMOVE;
        });
        this._addWindowTimeoutIds.set(window, sourceId);
    }

    _removeWindow(window) {
        let preview = this._windowPreviews.get(window);
        if (!preview)
            return;

        // Remove any pending timeout for this window
        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }

        this._windowPreviews.delete(window);
        preview.destroy();

        this._windowCount--;
        this._updateThumbnailSize();
    }

    _updateThumbnailSize() {
        // Adjust icon sizes in window previews based on thumbnail size
        let iconSize = 96; // Default size for large

        if (this._windowCount >= 7) {
            iconSize = 48; // Smallest icons for many windows
        } else if (this._windowCount >= 5) {
            iconSize = 72; // Medium icons
        }
        // For 0-3 windows, keep default 96px

        // Update all window previews
        for (let preview of this._windowPreviews.values()) {
            if (preview.icon_size !== iconSize) {
                preview.icon_size = iconSize;
                preview._updateIcon(); // Force icon refresh
            }
        }
    }

    _onRestacked() {
        let lastPreview = null;
        let windows = global.get_window_actors().map(a => a.meta_window);
        for (let i = 0; i < windows.length; i++) {
            let preview = this._windowPreviews.get(windows[i]);
            if (!preview)
                continue;

            lastPreview = preview;
        }
    }

    _moveWindow(window) {
        let monitorIndex = Main.layoutManager.findIndexForActor(this);
        if (monitorIndex !== window.get_monitor())
            window.move_to_monitor(monitorIndex);
        window.change_workspace(this._workspace);
    }

    // Explicitly cancel main loop sources without destroying the actor
    cleanupSources() {
        for (const [, id] of this._addWindowTimeoutIds) {
            GLib.Source.remove(id);
        }
        this._addWindowTimeoutIds.clear();
    }

    destroy() {
        this._workspace.disconnect(this._windowAddedId);
        this._workspace.disconnect(this._windowRemovedId);
        Display.disconnect(this._restackedId);
        Display.disconnect(this._windowCreatedId);
        // Clear any pending timeouts
        for (const [, id] of this._addWindowTimeoutIds) {
            GLib.Source.remove(id);
        }
        this._addWindowTimeoutIds.clear();

        if (this._wsChangedId && WorkspaceManager) {
            WorkspaceManager.disconnect(this._wsChangedId);
            this._wsChangedId = null;
        }

        super.destroy();
    }
}

// The top-level indicator that sits in the GNOME top panel.
// Contains all WorkspaceThumbnails in a row (or vertical layout if orientation changes).
class WorkspaceIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(0.0, _('Workspace Indicator'));

        this.reactive = false;

        // let container = new St.Widget({
        //     layout_manager: new Clutter.BinLayout(),
        //     x_expand: true,
        //     y_expand: true,
        // });

        // this.add_child(container);

        // Main container
        this._mainBox = new St.BoxLayout({
            style_class: 'workspace-indicator-main-box',
            y_expand: true,
            x_expand: true,
            reactive: true,
        });

        // Current workspace name label
        this._workspaceName = new St.Label({
            style_class: 'workspace-name-label',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            text: this._getCurrentWorkspaceName(),
        });

        // Thumbnails container
        this._thumbnailsBox = new St.BoxLayout({
            style_class: 'workspace-indicator-class',
            y_expand: true,
            x_expand: true,
            reactive: true,
        });

        // Add both to main box
        this._mainBox.add_child(this._workspaceName);
        this._mainBox.add_child(this._thumbnailsBox);

        this.add_child(this._mainBox);

        // this._workspacesItems = [];
        this._workspaceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._workspaceSection);

        this._workspaceManagerSignals = [
            WorkspaceManager.connect_after('notify::n-workspaces',
                this._updateThumbnails.bind(this)),
            WorkspaceManager.connect_after('workspace-switched',
                this._onWorkspaceSwitched.bind(this)),
        ];

        // this._createWorkspacesSection();
        this._updateThumbnails();
    }

    // Add this method from the reference code
    _getCurrentWorkspaceName() {
        const workspaceManager = global.workspace_manager;
        const currentWorkspace = workspaceManager.get_active_workspace_index();
        return Meta.prefs_get_workspace_name(currentWorkspace);
    }

    // Add this method from the reference code
    _onWorkspaceSwitched() {
        this._workspaceName.set_text(this._getCurrentWorkspaceName());
        this._updateActiveThumbnail(); // Keep existing functionality
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

    _updateActiveThumbnail() {
        let thumbs = this._thumbnailsBox.get_children();
        for (let i = 0; i < thumbs.length; i++) {
            if (i === WorkspaceManager.get_active_workspace_index())
                thumbs[i].add_style_class_name('active');
            else
                thumbs[i].remove_style_class_name('active');
        }
    }

    _updateThumbnails() {
        this._thumbnailsBox.destroy_all_children();

        for (let i = 0; i < WorkspaceManager.n_workspaces; i++) {
            let thumb = new WorkspaceThumbnail(WorkspaceManager.get_workspace_by_index(i));
            this._thumbnailsBox.add_child(thumb);
        }
        this._updateActiveThumbnail();
    }

    // Explicitly cancel any GLib sources created by thumbnails
    cleanupSources() {
        let thumbs = this._thumbnailsBox.get_children();
        for (let i = 0; i < thumbs.length; i++) {
            if (typeof thumbs[i].cleanupSources === 'function')
                thumbs[i].cleanupSources();
        }
    }

}

export default class TopNotchWorkspaces extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._handles = [];
        this._origUpdateSwitcher = null;
    }

    enable() {
        setLogFn((msg, error = false) => {
            let level;
            if (error) {
                level = GLib.LogLevelFlags.LEVEL_CRITICAL;
            } else {
                level = GLib.LogLevelFlags.LEVEL_MESSAGE;
            }

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

        // journalctl -f -o cat SYSLOG_IDENTIFIER=workspaces-organizer-by-blueray453
        journal(`Enabled`);

        // Workspace indicator in top bar
        this._indicator = new WorkspaceIndicator();
        Main.panel.addToStatusArea('workspace-indicator', this._indicator, 0, 'left');
    }

    disable() {
        // Destroy workspace indicator
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
