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

const States = {
    IDLE: 'idle',                    // No hover, no previews
    SHOWING_PREVIEW: 'showing_preview',  // Live window preview visible
    SHOWING_TITLE: 'showing_title',      // Title popup visible
    CLEANUP_DELAY: 'cleanup_delay',      // Waiting before cleanup
};

const PreviewRegistry = {
    activePreview: null,

    registerPreview(preview) {
        journal(`[PreviewRegistry] Registering preview for window: ${preview._window.title}`);

        // Only cleanup if the active preview is actually showing something
        if (this.activePreview && this.activePreview !== preview) {
            if (this.activePreview._stateMachine.isShowingPreview ||
                this.activePreview._stateMachine.state === States.CLEANUP_DELAY) {
                journal(`[PreviewRegistry] Cleaning up active preview that's showing UI`);
                this.activePreview._stateMachine.forceIdle('new preview registered');
            } else {
                journal(`[PreviewRegistry] Active preview is already idle, skipping cleanup`);
            }
        }

        this.activePreview = preview;
    },

    unregisterPreview(preview) {
        if (this.activePreview === preview) {
            journal(`[PreviewRegistry] Unregistering preview for window: ${preview._window.title}`);
            this.activePreview = null;
        }
    }
};

// ==================== PREVIEW STATE MACHINE CLASS ====================

class PreviewStateMachine {
    constructor(callbacks) {
        this._state = States.IDLE;
        this._callbacks = callbacks;

        // Timers
        this._ctrlPollId = null;
        this._cleanupTimeoutId = null;

        // Ctrl key state
        this._ctrlPressed = false;

        journal(`[StateMachine] Initialized`);
    }

    get state() {
        return this._state;
    }

    get isShowingPreview() {
        return this._state === States.SHOWING_PREVIEW || this._state === States.SHOWING_TITLE;
    }

    /**
     * Main transition method
     */
    transition(newState, reason = '') {
        const oldState = this._state;

        if (oldState === newState) {
            journal(`[StateMachine] Already in state ${newState}, no transition needed`);
            return;
        }

        // Validate state transition
        const validTransitions = {
            [States.IDLE]: [States.SHOWING_PREVIEW, States.SHOWING_TITLE],
            [States.SHOWING_PREVIEW]: [States.SHOWING_TITLE, States.CLEANUP_DELAY, States.IDLE],
            [States.SHOWING_TITLE]: [States.SHOWING_PREVIEW, States.CLEANUP_DELAY, States.IDLE],
            [States.CLEANUP_DELAY]: [States.IDLE, States.SHOWING_PREVIEW, States.SHOWING_TITLE],
        };

        if (!validTransitions[oldState]?.includes(newState)) {
            journal(`[StateMachine] WARNING: Invalid transition ${oldState} → ${newState} (${reason})`);
            // Still allow the transition but log it
        }

        journal(`[StateMachine] Transition: ${oldState} → ${newState}${reason ? ` (${reason})` : ''}`);

        // Exit old state
        this._exitState(oldState);

        // Update state
        this._state = newState;

        // Enter new state
        this._enterState(newState);

        journal(`[StateMachine] Transition complete, now in ${this._state}`);
    }

    /**
     * Exit state cleanup
     */
    _exitState(state) {
        journal(`[StateMachine] Exiting state: ${state}`);

        switch (state) {
            case States.CLEANUP_DELAY:
                this._stopCleanupTimer();
                break;

            case States.SHOWING_PREVIEW:
            case States.SHOWING_TITLE:
                // Only stop Ctrl poll if transitioning OUT of preview states
                // If we're transitioning between preview states (preview ↔ title), keep the poll
                const isStayingInPreview = this._state === States.SHOWING_PREVIEW ||
                    this._state === States.SHOWING_TITLE;

                if (!isStayingInPreview) {
                    journal(`[StateMachine] Leaving preview states, stopping Ctrl poll`);
                    this._stopCtrlPoll();
                } else {
                    journal(`[StateMachine] Staying in preview states, keeping Ctrl poll`);
                }
                break;
        }
    }

    /**
     * Enter state setup
     */
    _enterState(state) {
        journal(`[StateMachine] Entering state: ${state}, ctrlPressed=${this._ctrlPressed}`);

        this._stopCleanupTimer();

        switch (state) {
            case States.SHOWING_PREVIEW:
                this._callbacks.onShowPreview();
                if(!this._ctrlPollId) {
                    this._startCtrlPoll();
                } else {
                    journal(`[StateMachine] Ctrl poll already running (ID: ${this._ctrlPollId}), keeping it`);
                }
                break;

            case States.SHOWING_TITLE:
                this._callbacks.onShowTitle();
                if (!this._ctrlPollId) {
                    this._startCtrlPoll();
                } else {
                    journal(`[StateMachine] Ctrl poll already running (ID: ${this._ctrlPollId}), keeping it`);
                }
                break;

            case States.CLEANUP_DELAY:
                this._startCleanupTimer();
                break;

            case States.IDLE:
                this._callbacks.onHideAll();
                break;
        }
    }

    /**
     * Handle hover enter on the icon
     */
    onIconHoverEnter() {
        journal(`[StateMachine] Icon hover enter, current state: ${this._state}`);

        if (this._state === States.CLEANUP_DELAY) {
            // Cancel cleanup and return to preview
            journal(`[StateMachine] Cancelling cleanup, returning to preview`);
            this._checkCtrlKeyState();
            this.transition(
                this._ctrlPressed ? States.SHOWING_TITLE : States.SHOWING_PREVIEW,
                'hover re-entered during cleanup'
            );
        } else if (this._state === States.IDLE) {
            // Start showing preview
            this._checkCtrlKeyState();
            this.transition(
                this._ctrlPressed ? States.SHOWING_TITLE : States.SHOWING_PREVIEW,
                'initial hover'
            );
        }
    }

    /**
     * Handle hover leave on the icon
     */
    onIconHoverLeave() {
        journal(`[StateMachine] Icon hover leave, current state: ${this._state}`);

        if (this._state === States.SHOWING_PREVIEW || this._state === States.SHOWING_TITLE) {
            // Start cleanup delay
            this.transition(States.CLEANUP_DELAY, 'icon hover left');
        }
    }

    /**
     * Handle preview hover enter
     */
    onPreviewHoverEnter() {
        journal(`[StateMachine] Preview hover enter, current state: ${this._state}`);

        if (this._state === States.CLEANUP_DELAY) {
            // Cancel cleanup and return to preview
            journal(`[StateMachine] Preview hovered, cancelling cleanup`);
            this._checkCtrlKeyState();
            this.transition(
                this._ctrlPressed ? States.SHOWING_TITLE : States.SHOWING_PREVIEW,
                'preview hovered during cleanup'
            );
        }
    }

    /**
     * Handle preview hover leave
     */
    onPreviewHoverLeave(iconHovered) {
        // Handle possible undefined value from signals
        const isIconHovered = Boolean(iconHovered);
        journal(`[StateMachine] Preview hover leave, iconHovered: ${isIconHovered}, current state: ${this._state}`);

        if (!isIconHovered && this.isShowingPreview) {
            // Neither icon nor preview is hovered
            this.transition(States.CLEANUP_DELAY, 'preview and icon not hovered');
        }
    }

    /**
     * Force transition to IDLE (e.g., on click or workspace change)
     */
    forceIdle(reason = '') {
        journal(`[StateMachine] Forcing IDLE state${reason ? `: ${reason}` : ''}`);

        // Notify preview to unregister from registry
        if (this._callbacks && this._callbacks.onForceIdle) {
            this._callbacks.onForceIdle();
        }

        this.transition(States.IDLE, reason);
    }

    // ==================== CTRL KEY POLLING ====================

    /**
     * Check current Ctrl key state
     */
    _checkCtrlKeyState() {
        const [, , mods] = global.get_pointer();
        this._ctrlPressed = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        journal(`[StateMachine] Checked Ctrl state: ${this._ctrlPressed}`);
    }

    /**
     * Start polling for Ctrl key changes
     */
    _startCtrlPoll() {
        this._stopCtrlPoll();

        journal(`[StateMachine] Starting Ctrl poll from state: ${this._state}`);

        // Check if we actually have something to preview before starting poll
        const hasPreviewContent = (this._state === States.SHOWING_PREVIEW && this._callbacks.hasPreview()) ||
            (this._state === States.SHOWING_TITLE && this._callbacks.hasTitle());

        if (!hasPreviewContent) {
            journal(`[StateMachine] No preview content available, skipping Ctrl poll start`);
            return;
        }

        this._ctrlPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TimeoutDelay,
            () => {
                return this._onCtrlPollTick();
            }
        );
    }

    /**
     * Stop polling for Ctrl key changes
     */
    _stopCtrlPoll() {
        if (this._ctrlPollId) {
            // Check if the source still exists before removing
            const sourceId = this._ctrlPollId;
            this._ctrlPollId = null;

            // Only remove if the source still exists
            if (GLib.Source.remove(sourceId)) {
                journal(`[StateMachine] Stopped Ctrl poll ID ${sourceId}`);
            } else {
                journal(`[StateMachine] Ctrl poll ID ${sourceId} was already removed`);
            }
        }
    }

    /**
     * Ctrl poll tick handler
     */
    _onCtrlPollTick() {
        if (!this.isShowingPreview) {
            journal(`[StateMachine] Not showing preview anymore, stopping Ctrl poll`);
            this._stopCtrlPoll();
            return GLib.SOURCE_REMOVE;
        }

        const hasPreview = (this._state === States.SHOWING_PREVIEW && this._callbacks.hasPreview()) ||
            (this._state === States.SHOWING_TITLE && this._callbacks.hasTitle());

        if (!hasPreview) {
            journal(`[StateMachine] Poll check: Preview/title missing, forcing IDLE`);
            this.forceIdle('preview missing during poll');
            return GLib.SOURCE_REMOVE;
        }

        // Check if we should still be polling
        if (!this.isShowingPreview) {
            journal(`[StateMachine] Not showing preview, stopping Ctrl poll`);
            this._stopCtrlPoll();
            return GLib.SOURCE_REMOVE;
        }

        // Check for Ctrl key state change
        const [, , mods] = global.get_pointer();
        const ctrlDown = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (ctrlDown !== this._ctrlPressed) {
            this._ctrlPressed = ctrlDown;
            journal(`[StateMachine] Ctrl state changed: ${this._ctrlPressed}`);

            // Switch preview type
            if (this._state === States.SHOWING_PREVIEW && ctrlDown) {
                this.transition(States.SHOWING_TITLE, 'Ctrl pressed');
            } else if (this._state === States.SHOWING_TITLE && !ctrlDown) {
                this.transition(States.SHOWING_PREVIEW, 'Ctrl released');
            }
        }

        return GLib.SOURCE_CONTINUE;
    }

    // ==================== CLEANUP TIMER ====================

    /**
     * Start cleanup delay timer
     */
    _startCleanupTimer() {
        this._stopCleanupTimer();

        journal(`[StateMachine] Starting cleanup timer`);

        this._cleanupTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TimeoutDelay,
            () => {
                journal(`[StateMachine] Cleanup timer fired, checking hover states`);

                // Check if callback says we should abort
                if (this._callbacks.shouldAbortCleanup()) {
                    journal(`[StateMachine] Cleanup aborted - still hovering`);
                    this._cleanupTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }

                // Proceed with cleanup
                this.transition(States.IDLE, 'cleanup timer completed');
                this._cleanupTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Stop cleanup timer
     */
    _stopCleanupTimer() {
        if (this._cleanupTimeoutId) {
            journal(`[StateMachine] Stopping cleanup timer ID ${this._cleanupTimeoutId}`);
            GLib.source_remove(this._cleanupTimeoutId);
            this._cleanupTimeoutId = null;
        }
    }

    /**
     * Cleanup all resources
     */
    destroy() {
        journal(`[StateMachine] Destroying, current state: ${this._state}`);

        // Force transition to IDLE to clean up any UI
        if (this._state !== States.IDLE && this._callbacks && this._callbacks.onHideAll) {
            this._callbacks.onHideAll();
        }

        this._stopCtrlPoll();
        this._stopCleanupTimer();

        this._callbacks = null;

        journal(`[StateMachine] Destroyed`);
    }
}

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

        // DND setup
        this._delegate = this;
        DND.makeDraggable(this, { restoreOnSuccess: true });

        // Initialize state machine
        this._stateMachine = new PreviewStateMachine({
            onShowPreview: this._showHoverPreview.bind(this),
            onShowTitle: this._showTitlePopup.bind(this),
            onHideAll: this._hideAllPreviews.bind(this),
            shouldAbortCleanup: this._shouldAbortCleanup.bind(this),
            hasPreview: () => !!this._hoverPreview,
            hasTitle: () => !!this._titlePopup,
            onForceIdle: () => {
                PreviewRegistry.unregisterPreview(this);
            }
        });

        // Initialize icon
        this._updateIcon();

        // Connect window signals
        this._wmClassChangedId = this._window.connect('notify::wm-class',
            this._updateIcon.bind(this));
        this._mappedId = this._window.connect('notify::mapped',
            this._updateIcon.bind(this));

        // Connect hover signal with debounce
        this._hoverTimeoutId = null;

        this._hoverSignalId = this.connect('notify::hover', () => {
            journal(`[WindowPreview] notify::hover: hover=${this.hover}, state=${this._stateMachine.state}`);

            // Clear existing timeout
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }

            // If we're already showing preview, handle immediately (no debounce)
            if (this._stateMachine.isShowingPreview || this._stateMachine.state === States.CLEANUP_DELAY) {
                if (this.hover) {
                    journal(`[WindowPreview] Already showing preview, handling hover immediately`);
                    PreviewRegistry.registerPreview(this);
                    this._stateMachine.onIconHoverEnter();
                } else {
                    journal(`[WindowPreview] Already showing preview, handling leave immediately`);
                    this._stateMachine.onIconHoverLeave();
                }
                return;
            }

            // Only debounce when entering from IDLE state
            if (this.hover) {
                this._hoverTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    30,
                    () => {
                        this._hoverTimeoutId = null;

                        // Check if we're still in IDLE state (not changed by another event)
                        if (this._stateMachine.state === States.IDLE) {
                            PreviewRegistry.registerPreview(this);
                            this._stateMachine.onIconHoverEnter();
                        } else {
                            journal(`[WindowPreview] State changed during debounce, skipping`);
                        }

                        return GLib.SOURCE_REMOVE;
                    }
                );
            } else {
                // Handle leave immediately when in IDLE state
                this._stateMachine.onIconHoverLeave();
            }
        });

        // Connect button press signal
        this._buttonPressedId = this.connect('button-press-event',
            this._onButtonPressed.bind(this));

        // Connect workspace change signal
        this._wsChangedId = WorkspaceManager.connect('workspace-switched', () => {
            journal(`[WindowPreview] Workspace switched`);
            this._stateMachine.forceIdle('workspace switched');

            if (this._contextMenu) {
                this._contextMenu.close();
                this._contextMenu = null;
            }
        });
    }

    // ==================== EVENT HANDLERS ====================

    _onButtonPressed(actor, event) {
        let button = event.get_button();

        if (button === Clutter.BUTTON_PRIMARY) {
            journal(`[WindowPreview] Left click detected`);
            this._stateMachine.forceIdle('left click');

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
            journal(`[WindowPreview] Right click detected`);
            this._stateMachine.forceIdle('right click');
            this._showContextMenu();
            return Clutter.EVENT_STOP;
        }
    }

    _shouldAbortCleanup() {
        const iconHovered = this.hover;
        const previewHovered = this._hoverPreview?.hover || false;
        const titleHovered = this._titlePopup?.hover || false;

        const shouldAbort = iconHovered || previewHovered || titleHovered;

        journal(`[WindowPreview] shouldAbortCleanup: icon=${iconHovered}, preview=${previewHovered}, title=${titleHovered} → ${shouldAbort}`);

        return shouldAbort;
    }

    // ==================== PREVIEW METHODS ====================

    _showHoverPreview() {
        journal(`[WindowPreview] _showHoverPreview: Starting`);

        if (!this._window) {
            journal(`[WindowPreview] _showHoverPreview: No window`);
            return;
        }

        // Hide title popup if it exists
        this._hideTitlePopup();

        // Don't recreate if already exists
        if (this._hoverPreview) {
            journal(`[WindowPreview] _showHoverPreview: Preview already exists`);
            return;
        }

        // Abort if mouse left before we could create preview
        if (!this.hover && (!this._hoverPreview || !this._hoverPreview.hover)) {
            journal(`[WindowPreview] _showHoverPreview: Mouse no longer hovering, aborting`);
            this._stateMachine._stopCtrlPoll();
            return;
        }

        // Check if we should still show preview (atomic check)
        const shouldShow = this.hover ||
            (this._hoverPreview && this._hoverPreview.hover) ||
            this._stateMachine.state === States.SHOWING_PREVIEW;

        if (!shouldShow) {
            journal(`[WindowPreview] _showHoverPreview: Not hovering and not in showing state, aborting`);
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
            this._stateMachine.forceIdle('close button clicked');
            return Clutter.EVENT_STOP;
        });

        // Build hierarchy
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
            journal(`[WindowPreview] HoverPreview hover changed: ${outerWrapper.hover}, button hover: ${this.hover}`);

            if (outerWrapper.hover) {
                // Mouse entered preview
                this._stateMachine.onPreviewHoverEnter();
            } else {
                // Mouse left preview
                this._stateMachine.onPreviewHoverLeave(this.hover);
            }
        });

        outerWrapper.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._window.get_workspace().activate_with_focus(this._window, 0);
                this._stateMachine.forceIdle('preview clicked');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        journal(`[WindowPreview] _showHoverPreview: Completed`);
    }

    _showTitlePopup() {
        journal(`[WindowPreview] _showTitlePopup: Starting`);

        if (!this._window) {
            journal(`[WindowPreview] _showTitlePopup: No window`);
            return;
        }

        // Hide hover preview if it exists
        this._hideHoverPreview();

        // Don't recreate if already exists
        if (this._titlePopup) {
            journal(`[WindowPreview] _showTitlePopup: Popup already exists`);
            return;
        }

        // Abort if mouse left before we could create popup
        if (!this.hover) {
            journal(`[WindowPreview] _showTitlePopup: Mouse no longer hovering, aborting`);
            this._stateMachine._stopCtrlPoll();
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

            if (label.hover) {
                // Mouse entered title popup
                this._stateMachine.onPreviewHoverEnter();
            } else {
                // Mouse left title popup
                this._stateMachine.onPreviewHoverLeave(this.hover);
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
                    // https://gjs-docs.gnome.org/shell16~16/shell.app#method-launch_action
                    app.launch_action(action, 0, -1);
                });
            });
        }

        menu.open(true);

        if (menu._boxPointer) {
            menu._boxPointer.translation_y = -35;
        }
    }

    _cleanupOtherPreviews() {
        if (PreviewRegistry.activePreview && PreviewRegistry.activePreview !== this) {
            const otherPreview = PreviewRegistry.activePreview;
            const otherState = otherPreview._stateMachine.state;

            // Only cleanup if the other preview is actually showing something
            if (otherState === States.SHOWING_PREVIEW ||
                otherState === States.SHOWING_TITLE ||
                otherState === States.CLEANUP_DELAY) {
                journal(`[WindowPreview] Cleaning up other preview: ${otherPreview._window.title} (state: ${otherState})`);
                otherPreview._stateMachine.forceIdle('new preview activated');
            } else {
                journal(`[WindowPreview] Other preview is already idle (state: ${otherState}), skipping cleanup`);
            }
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
        journal(`[WindowPreview] destroy: Cleaning up, current state=${this._stateMachine.state}`);

        // Clean up context menu first
        this._cleanupContextMenu();

        // Unregister from preview registry
        PreviewRegistry.unregisterPreview(this);

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

        // Clean up icon actor signals
        if (this._iconSignalId && this._iconActor) {
            this._iconActor.disconnect(this._iconSignalId);
            this._iconSignalId = null;
        }

        // Clear hover debounce timeout
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        // Destroy state machine (this will stop all timers)
        if (this._stateMachine) {
            this._stateMachine.destroy();
            this._stateMachine = null;
        }

        // Clean up UI
        this._hideAllPreviews();

        // Remove children
        if (this.get_child()) {
            this.set_child(null);
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
