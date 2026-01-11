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

// gettext is provided via the Extension module import above

const WorkspaceManager = global.get_workspace_manager();
const WindowTracker = global.get_window_tracker();
const Display = global.get_display();
const TimeoutDelay = 200;

const States = {
    IDLE: 'idle',                    // No hover, no previews
    HOVERING: 'hovering',            // Mouse over button, deciding what to show
    SHOWING_PREVIEW: 'showing_preview',  // Live window preview visible
    SHOWING_TITLE: 'showing_title',      // Title popup visible
    CLEANUP_DELAY: 'cleanup_delay',      // Waiting before cleanup
    SWITCHING: 'switching'               // Transition between preview types
};

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

        // State machine properties
        this._state = States.IDLE;
        this._ctrlPressed = false;
        this._timerId = null;
        this._cleanupTimeoutId = null;

        // UI elements
        this._hoverPreview = null;
        this._titlePopup = null;
        this._contextMenu = null;

        this._delegate = this;
        DND.makeDraggable(this, { restoreOnSuccess: true });

        this.icon_size = 96;

        this._updateIcon();

        // Window signals
        this._wmClassChangedId = this._window.connect('notify::wm-class',
            this._updateIcon.bind(this));
        this._mappedId = this._window.connect('notify::mapped',
            this._updateIcon.bind(this));

        // Single hover signal handler
        this._hoverSignalId = this.connect('notify::hover', () => {
            journal(`[WindowPreview] notify::hover: hover=${this.hover}, state=${this._state}`);
            this._onHoverChanged();
        });

        // Button press handler
        this._buttonPressedId = this.connect('button-press-event',
            this._onButtonPressed.bind(this));

        // Workspace change handler
        this._wsChangedId = WorkspaceManager.connect('workspace-switched', () => {
            journal(`[WindowPreview] Workspace switched, transitioning to IDLE`);
            this._transition(States.IDLE);
            if (this._contextMenu) {
                this._contextMenu.close();
                this._contextMenu = null;
            }
        });

        // Global key listener setup
        this._setupKeyListeners();
    }

    // ==================== STATE MACHINE METHODS ====================

    _transition(newState) {
        const oldState = this._state;

        if (oldState === newState) {
            journal(`[WindowPreview] _transition: Already in state ${newState}`);
            return;
        }

        journal(`[WindowPreview] _transition: ${oldState} → ${newState}`);
        this._state = newState;

        // Exit old state
        this._exitState(oldState);

        // Enter new state
        this._enterState(newState);
    }

    _exitState(state) {
        journal(`[WindowPreview] _exitState: ${state}`);

        switch (state) {
            case States.CLEANUP_DELAY:
                if (this._cleanupTimeoutId) {
                    GLib.source_remove(this._cleanupTimeoutId);
                    this._cleanupTimeoutId = null;
                }
                break;

            case States.SHOWING_PREVIEW:
            case States.SHOWING_TITLE:
                // Stop polling timer when leaving preview states
                this._stopTimer();
                break;
        }
    }

    _enterState(state) {
        journal(`[WindowPreview] _enterState: ${state}, ctrlPressed=${this._ctrlPressed}`);

        switch (state) {
            case States.HOVERING:
                // Decide what to show based on Ctrl key
                this._checkCtrlKeyState();
                if (this._ctrlPressed) {
                    this._transition(States.SHOWING_TITLE);
                } else {
                    this._transition(States.SHOWING_PREVIEW);
                }
                break;

            case States.SHOWING_PREVIEW:
                this._hideTitlePopup();
                // Only create preview if it doesn't exist
                if (!this._hoverPreview) {
                    this._showHoverPreview();
                } else {
                    journal(`[WindowPreview] Preview already exists, not creating new one`);
                }
                this._startCtrlPoll();
                break;

            case States.SHOWING_TITLE:
                this._hideHoverPreview();
                this._showTitlePopup();
                this._startCtrlPoll();
                break;

            case States.CLEANUP_DELAY:
                this._stopTimer();
                this._startCleanupTimer();
                break;

            case States.IDLE:
                this._stopTimer();
                this._hideAllPreviews();
                break;

            case States.SWITCHING:
                // Temporary state - immediately transition based on Ctrl
                if (this._ctrlPressed) {
                    this._transition(States.SHOWING_TITLE);
                } else {
                    this._transition(States.SHOWING_PREVIEW);
                }
                break;
        }
    }

    // ==================== EVENT HANDLERS ====================

    _onHoverChanged() {
        if (this.hover) {
            journal(`[WindowPreview] _onHoverChanged: Hover started, current state=${this._state}`);

            if (this._state === States.CLEANUP_DELAY) {
                // Cancel cleanup if we hover again
                journal(`[WindowPreview] Cancelling cleanup, returning to preview`);
                if (this._cleanupTimeoutId) {
                    GLib.source_remove(this._cleanupTimeoutId);
                    this._cleanupTimeoutId = null;
                }

                // Return to appropriate preview state
                if (this._ctrlPressed) {
                    this._transition(States.SHOWING_TITLE);
                } else {
                    this._transition(States.SHOWING_PREVIEW);
                }
            } else if (this._state === States.IDLE) {
                // Start hover process
                this._transition(States.HOVERING);
            }
            // If already in preview state, do nothing
        } else {
            journal(`[WindowPreview] _onHoverChanged: Hover ended, current state=${this._state}`);

            if (this._state === States.SHOWING_PREVIEW ||
                this._state === States.SHOWING_TITLE ||
                this._state === States.HOVERING) {
                // Start cleanup delay
                this._transition(States.CLEANUP_DELAY);
            }
        }
    }

    _onButtonPressed(actor, event) {
        let button = event.get_button();

        if (button === Clutter.BUTTON_PRIMARY) {
            journal(`[WindowPreview] Left click detected, transitioning to IDLE`);
            this._transition(States.IDLE);

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
            journal(`[WindowPreview] Right click detected, creating context menu`);
            this._transition(States.IDLE);

            let menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP);
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

            return Clutter.EVENT_STOP;
        }
    }

    // ==================== KEYBOARD HANDLING ====================

    _setupKeyListeners() {
        // Poll for Ctrl key state
        this._keyPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TimeoutDelay,
            this._pollCtrlKey.bind(this)
        );
    }

    _pollCtrlKey() {
        const [, , mods] = global.get_pointer();
        const ctrlDown = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (ctrlDown !== this._ctrlPressed) {
            this._ctrlPressed = ctrlDown;
            this._onCtrlKeyChanged();
        }

        return GLib.SOURCE_CONTINUE;
    }

    _checkCtrlKeyState() {
        const [, , mods] = global.get_pointer();
        this._ctrlPressed = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        journal(`[WindowPreview] _checkCtrlKeyState: Initial Ctrl state=${this._ctrlPressed}`);
    }

    _onCtrlKeyChanged() {
        // Only handle Ctrl changes when we're showing previews
        if (this._state === States.SHOWING_PREVIEW && this._ctrlPressed) {
            journal(`[WindowPreview] Switching from preview to title`);
            this._transition(States.SWITCHING);
        } else if (this._state === States.SHOWING_TITLE && !this._ctrlPressed) {
            journal(`[WindowPreview] Switching from title to preview`);
            this._transition(States.SWITCHING);
        }
    }

    // ==================== TIMER MANAGEMENT ====================

    _startCtrlPoll() {
        journal(`[WindowPreview] _startCtrlPoll: Starting Ctrl poll timer`);

        this._stopTimer();

        this._timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TimeoutDelay,
            this._onCtrlPollTick.bind(this)
        );
    }

    _onCtrlPollTick() {
        journal(`[WindowPreview] _onCtrlPollTick: state=${this._state}, ctrlPressed=${this._ctrlPressed}`);

        // Check if we should still be polling
        if (this._state !== States.SHOWING_PREVIEW &&
            this._state !== States.SHOWING_TITLE) {
            journal(`[WindowPreview] _onCtrlPollTick: Not in preview state, stopping poll`);
            this._stopTimer();
            return GLib.SOURCE_REMOVE;
        }

        return GLib.SOURCE_CONTINUE;
    }

    _startCleanupTimer() {
        journal(`[WindowPreview] _startCleanupTimer: Starting cleanup delay`);

        this._cleanupTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TimeoutDelay,
            () => {
                journal(`[WindowPreview] Cleanup timer fired, state=${this._state}`);

                // Check if mouse moved to preview
                if (this._hoverPreview && this._hoverPreview.hover) {
                    journal(`[WindowPreview] Mouse moved to preview, cancelling cleanup`);
                    this._cleanupTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }

                if (this._titlePopup && this._titlePopup.hover) {
                    journal(`[WindowPreview] Mouse moved to title popup, cancelling cleanup`);
                    this._cleanupTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }

                // Proceed with cleanup
                this._transition(States.IDLE);
                this._cleanupTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            journal(`[WindowPreview] _stopTimer: Stopping timer ID ${this._timerId}`);
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    // ==================== PREVIEW METHODS ====================

    _showHoverPreview() {
        journal(`[WindowPreview] _showHoverPreview: Starting`);

        if (!this._window || this._hoverPreview) {
            journal(`[WindowPreview] _showHoverPreview: Cannot show - window: ${!!this._window}, hoverPreview: ${!!this._hoverPreview}`);
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
            this._transition(States.IDLE);
            return Clutter.EVENT_STOP;
        });

        // Build hierarchy
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
            journal(`[WindowPreview] HoverPreview hover changed: ${outerWrapper.hover}, button hover: ${this.hover}`);

            if (outerWrapper.hover) {
                // Mouse entered preview - cancel any pending cleanup
                if (this._state === States.CLEANUP_DELAY && this._cleanupTimeoutId) {
                    journal(`[WindowPreview] Mouse entered preview, cancelling cleanup`);
                    GLib.source_remove(this._cleanupTimeoutId);
                    this._cleanupTimeoutId = null;
                    this._transition(States.SHOWING_PREVIEW);
                }
            } else {
                // Mouse left preview - start cleanup if not hovering button
                if (!this.hover && this._state === States.SHOWING_PREVIEW) {
                    journal(`[WindowPreview] Mouse left preview and button, starting cleanup`);
                    this._transition(States.CLEANUP_DELAY);
                }
            }
        });

        outerWrapper.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._window.get_workspace().activate_with_focus(this._window, 0);
                this._transition(States.IDLE);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        journal(`[WindowPreview] _showHoverPreview: Completed`);
    }

    _showTitlePopup() {
        journal(`[WindowPreview] _showTitlePopup: Starting`);

        if (!this._window || this._titlePopup) {
            journal(`[WindowPreview] _showTitlePopup: Cannot show - window: ${!!this._window}, titlePopup: ${!!this._titlePopup}`);
            return;
        }

        if (!this.hover) {
            journal(`[WindowPreview] Mouse no longer on icon, aborting title popup`);
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
            journal(`[WindowPreview] TitlePopup hover changed: ${label.hover}, button hover: ${this.hover}`);

            if (!label.hover && !this.hover) {
                this._transition(States.CLEANUP_DELAY);
            }
        });

        journal(`[WindowPreview] _showTitlePopup: Completed`);
    }

    _hideHoverPreview() {
        journal(`[WindowPreview] _hideHoverPreview: Starting`);

        if (!this._hoverPreview) {
            journal(`[WindowPreview] _hideHoverPreview: No preview to hide`);
            return;
        }

        const wrapper = this._hoverPreview;
        this._hoverPreview = null;

        Main.layoutManager.removeChrome(wrapper);
        wrapper.destroy();

        journal(`[WindowPreview] _hideHoverPreview: Completed`);
    }

    _hideTitlePopup() {
        journal(`[WindowPreview] _hideTitlePopup: Starting`);

        if (!this._titlePopup) {
            journal(`[WindowPreview] _hideTitlePopup: No popup to hide`);
            return;
        }

        const popup = this._titlePopup;
        this._titlePopup = null;

        Main.layoutManager.removeChrome(popup);
        popup.destroy();

        journal(`[WindowPreview] _hideTitlePopup: Completed`);
    }

    _hideAllPreviews() {
        journal(`[WindowPreview] _hideAllPreviews: Hiding all previews`);
        this._hideHoverPreview();
        this._hideTitlePopup();
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

        iconActor.connect('stage-views-changed', (actor) => {
            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = iconActor.get_transformed_position();
            [rect.width, rect.height] = iconActor.get_transformed_size();
            this._window.set_icon_geometry(rect);

            iconActor.disconnect(id);
        });
    }

    destroy() {
        journal(`[WindowPreview] destroy: Cleaning up, current state=${this._state}`);

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

        if (this._keyPollId) {
            GLib.source_remove(this._keyPollId);
            this._keyPollId = null;
        }

        // Stop all timers
        this._stopTimer();
        if (this._cleanupTimeoutId) {
            GLib.source_remove(this._cleanupTimeoutId);
            this._cleanupTimeoutId = null;
        }

        // Clean up UI
        this._transition(States.IDLE);

        if (this._contextMenu) {
            this._contextMenu.close();
            this._contextMenu = null;
        }

        super.destroy();

        journal(`[WindowPreview] destroy: Cleanup complete`);
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
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
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
