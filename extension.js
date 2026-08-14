import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
// import Pango from 'gi://Pango';

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

// Token-based fuzzy match: query is split on whitespace, each token
// must appear (substring, falling back to fuzzy subsequence) somewhere
// in the text. This is what lets "ext js" match "extension.js — VS Code"
// even though there's no literal space in that position in the text.
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
            score += 50 - Math.min(idx, 40); // earlier match = higher score
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
// Reuses the same clone/shadow math as WindowPreview._showHoverPreview,
// factored out so the collection overlay can use "the existing
// window-preview mechanism" per spec item 6. Optionally attaches a
// close button (mirrors WindowPreview's hover-preview close button).

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

    if (options.onClose) {
        const closeButton = new St.Button({
            style_class: 'window-close-button',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 32,
            }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            reactive: true,
        });

        closeButton.set_position(targetWidth - 46, 10);
        closeButton.connect('clicked', () => {
            options.onClose(window);
            return Clutter.EVENT_STOP;
        });

        cloneContainer.add_child(closeButton);
    }

    return { actor: container, width: targetWidth, height: targetHeight };
}

// ==================== THUMBNAIL REGISTRY ====================
// Tracks all live WorkspaceThumbnail actors so native (title-bar) window
// drags can be hit-tested against them on drop, independent of our own
// St/Clutter DND sessions.

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

// ==================== TITLE BAR DRAG MONITOR ====================
// Listens for native mutter window-move grabs (dragging a window by its
// title bar) and, on release, checks whether the pointer is over one of
// our workspace thumbnails. If so, moves the window there using the same
// normal GNOME window-move machinery already used by internal DND drops.
// This is NOT the same pipeline as DND.makeDraggable: title-bar drags are
// a compositor-level grab operation, not a Clutter/St DND session, so
// dnd.js never observes them and we must hook global.display directly.

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

        // Keep the original drop handling (it will move the window to the workspace
        // under the pointer, which is already correct after the hover switch).
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

    // ----- Polling for hover switch during drag -----

    _startDragPoll() {
        if (this._dragPollId) {
            GLib.Source.remove(this._dragPollId);
            this._dragPollId = 0;
        }
        journal(`[TitleBarDragMonitor] Starting drag poll`);
        this._dragPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            100,   // check every 100 ms
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
        // If already on that workspace, or we already switched to it, do nothing
        if (targetWs === currentWs || targetWs === this._lastSwitchedWorkspace)
            return GLib.SOURCE_CONTINUE;

        journal(`[TitleBarDragMonitor] Hover switch to workspace ${targetWs.index()}`);

        const window = this._currentDragWindow;

        // Move to the same monitor as the thumbnail
        const monitorIndex = Main.layoutManager.findIndexForActor(thumb);
        if (monitorIndex !== window.get_monitor())
            window.move_to_monitor(monitorIndex);

        // Move the window to the target workspace
        window.change_workspace(targetWs);

        // Activate the workspace (the window will still be dragged)
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

        // Drag-hover-to-activate state (for external drags: files, text, tabs, etc.)
        this._dragActivateTimeoutId = null;
        this._lastDragOverTime = 0;

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
        // const previewY = windowPreviewY - previewHeight - 40;
        const previewY = screenHeight - previewHeight - 200 + 55;

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
            this._forceHide('close button clicked');
            return Clutter.EVENT_STOP;
        });

        // BUILD HIERARCHY
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

    _showTitlePopup() {
        journal(`[WindowPreview] Showing title popup`);
        if (!this._window) return;

        this._hideHoverPreview();

        if (this._titlePopup) {
            journal(`[WindowPreview] Title popup already exists`);
            return;
        }

        const shouldShow = this.hover ||
            this._cleanupTimeoutId !== null ||
            (this._hoverPreview !== null || this._titlePopup !== null);

        if (!shouldShow) {
            journal(`[WindowPreview] Not hovering and no cleanup pending, aborting`);
            return;
        }

        const title = this._window.get_title() || "Untitled Window";
        const label = new St.Label({
            text: title,
            style_class: "hover-title-popup",
            reactive: true,
            track_hover: true,
        });

        Main.layoutManager.addChrome(label);

        let [iconX, iconY] = this.get_transformed_position();
        const iconWidth = this.width;

        const padding = 10;
        const maxWidth = screenWidth - (2 * padding);

        const labelWidth = Math.min(label.width, maxWidth);

        let labelX = iconX + (iconWidth - labelWidth) / 2;

        labelX = Math.max(padding, labelX);
        labelX = Math.min(labelX, screenWidth - labelWidth - padding);

        const labelY = screenHeight - 200;

        label.set_position(labelX, labelY);
        this._titlePopup = label;

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

        this._cancelCleanup();
        PreviewRegistry.unregisterPreview(this);
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

                const iconHovered = this.hover;
                const previewHovered = this._hoverPreview?.hover || false;
                const titleHovered = this._titlePopup?.hover || false;

                if (iconHovered || previewHovered || titleHovered) {
                    journal(`[WindowPreview] Cleanup aborted - still hovering`);
                    return GLib.SOURCE_REMOVE;
                }

                journal(`[WindowPreview] Cleanup timer completed`);

                PreviewRegistry.unregisterPreview(this);
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

    // ==================== DRAG HOVER ACTIVATION ====================
    // Lets you drag a file/text/tab from elsewhere, hover over this icon,
    // and have the underlying window raise+focus so you can then drop
    // onto the actual window surface.

    handleDragOver(source, actor, x, y, time) {
        if (source instanceof WindowPreview) {
            return DND.DragMotionResult.CONTINUE;
        }

        this._lastDragOverTime = GLib.get_monotonic_time();

        if (!this._dragActivateTimeoutId) {
            journal(`[WindowPreview] External drag hovering, scheduling activate`);
            this._dragActivateTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                400,
                () => {
                    this._dragActivateTimeoutId = null;

                    const elapsedMs = (GLib.get_monotonic_time() - this._lastDragOverTime) / 1000;
                    if (elapsedMs > 500) {
                        journal(`[WindowPreview] Drag left before activation, aborting`);
                        return GLib.SOURCE_REMOVE;
                    }

                    this._activateForDrag();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(_source) {
        return false;
    }

    _activateForDrag() {
        if (!this._window) return;

        journal(`[WindowPreview] Activating window for drag-hover: ${this._window.title}`);

        const win = this._window;
        if (win.minimized) win.unminimize();

        const winWs = win.get_workspace();
        winWs.activate_with_focus(win, global.get_current_time());
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

        menu.addAction(`Close Except ${this._window.title}`, () => {
            const targetWmClass = this._window.get_wm_class();

            const windowsToClose = Display.get_tab_list(
                Meta.TabList.NORMAL,
                this._window.get_workspace()
            ).filter(win =>
                win !== this._window &&
                win.get_wm_class() === targetWmClass &&
                win.get_wm_class_instance() !== 'file_progress'
            );

            const currentTime = global.get_current_time();

            for (const window of windowsToClose) {
                journal(`Closing window: ${window.get_title()}`);
                window.delete(currentTime);
            }
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
    }

    // ==================== UTILITY METHODS ====================

    _is_covered(window) {
        if (window.minimized) { return false; }
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

        this._forceHide('destroy');

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

        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        if (this._dragActivateTimeoutId) {
            GLib.source_remove(this._dragActivateTimeoutId);
            this._dragActivateTimeoutId = null;
        }

        if (this.get_child()) {
            this.set_child(null);
        }

        super.destroy();

        journal(`[WindowPreview] Destroyed`);
    }
}

// ==================== WINDOW COLLECTION OVERLAY ====================
// Fullscreen, modal, Solarized Dark search overlay for 6+ window mode.
// Never mutates window/workspace ordering or state — purely a display
// and activation surface. Search results are draggable and represent
// the real window (see _setResults / _onResultDragBegin).

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

    // Predictability requirement: group by app, then sort by title within
    // each app. This is purely a display-order computation — the
    // underlying workspace/stacking order is untouched.
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

        // Ensure it stacks above the top panel and every other chrome actor
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

            // Make this row a DND source representing the *actual window*,
            // matching the same protocol WorkspaceThumbnail.acceptDrop already
            // understands (source.realWindow -> a Meta.WindowActor).
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

        const built = createClonePreviewActor(window, this._previewBox.height, {
            onClose: (win) => this._closeWindowFromPreview(win),
        });
        if (!built)
            return;

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

    // Closing from the preview closes the real window (same as the taskbar
    // close-button / context-menu "Close" action) and then just prunes it
    // from the current result set — it does not reorder, reactivate, or
    // otherwise touch any other window.
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
        this._selectedIndex = -1; // force _selectIndex to treat it as a fresh selection
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

    // Fires once the pointer has moved past DND's built-in drag threshold —
    // i.e. this is a real drag, not a click. St.Button + DND.makeDraggable
    // already gives us click-vs-drag for free: a plain press/release under
    // threshold fires 'clicked' normally (see _activateResult), and only
    // exceeding the threshold reaches here, so a window is never activated
    // as a side effect of starting a drag.
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

        // Visually and functionally "closed" immediately: no longer modal,
        // no longer painted, no longer in chrome.
        Main.layoutManager.removeChrome(this._container);
        this._container.hide();

        // But don't destroy yet — dnd.js may still reference this._resultsBox
        // (button's original parent) to restore position if the drag is
        // cancelled or dropped somewhere invalid. Destroy only once dnd.js
        // signals it's fully done with the actor.
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
// Single icon shown when a workspace has more than DIRECT_MODE_MAX_WINDOWS.

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

// Represents a single workspace in the panel indicator.
// Holds a set of WindowPreviews for all windows in that workspace,
// or a single WindowCollectionIcon when there are more than
// DIRECT_MODE_MAX_WINDOWS windows.
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

        this._windowOrder = [];       // stable insertion-order list of tracked windows
        this._mode = 'direct';        // 'direct' | 'collection'
        this._collectionIcon = null;

        this.set_child(this._windowsBox);

        this._delegate = this; // needed for DND

        this._windowPreviews = new Map();
        this._addWindowTimeoutIds = new Map();

        this._workspace = workspace;

        ThumbnailRegistry.register(this);

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

            return Clutter.EVENT_STOP;
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
        if (window.skip_taskbar)
            return;

        if (this._windowOrder.includes(window))
            return;

        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }

        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
            this._addWindowTimeoutIds.delete(window);

            if (window.get_workspace() !== this._workspace)
                return GLib.SOURCE_REMOVE;

            if (!this._windowOrder.includes(window))
                this._windowOrder.push(window);

            this._syncDisplayMode();
            return GLib.SOURCE_REMOVE;
        });

        this._addWindowTimeoutIds.set(window, sourceId);
    }

    _removeWindow(window) {
        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }

        const idx = this._windowOrder.indexOf(window);
        if (idx === -1)
            return;

        this._windowOrder.splice(idx, 1);

        const preview = this._windowPreviews.get(window);
        if (preview) {
            this._windowPreviews.delete(window);
            if (this._windowsBox && preview.get_parent() === this._windowsBox)
                this._windowsBox.remove_child(preview);
            preview.destroy();
        }

        this._syncDisplayMode();
    }

    // ==================== DISPLAY MODE SWITCHING ====================
    // Deterministic: purely a function of this._windowOrder.length.
    // Never touches this._workspace, window stacking, or window state.

    _syncDisplayMode() {
        const count = this._windowOrder.length;

        if (count > DIRECT_MODE_MAX_WINDOWS)
            this._enterCollectionMode(count);
        else
            this._enterDirectMode();
    }

    _enterCollectionMode(count) {
        for (const preview of this._windowPreviews.values()) {
            if (preview.get_parent() === this._windowsBox)
                this._windowsBox.remove_child(preview);
            preview.destroy();
        }
        this._windowPreviews.clear();

        if (!this._collectionIcon) {
            this._collectionIcon = new WindowCollectionIcon(() => this._windowOrder.slice());
            this._windowsBox.add_child(this._collectionIcon);
        }

        this._collectionIcon.setCount(count);
        this._mode = 'collection';
    }

    _enterDirectMode() {
        if (this._collectionIcon) {
            if (this._collectionIcon.get_parent() === this._windowsBox)
                this._windowsBox.remove_child(this._collectionIcon);
            this._collectionIcon.destroy();
            this._collectionIcon = null;
        }

        for (const window of this._windowOrder) {
            if (this._windowPreviews.has(window))
                continue;
            if (!this._windowsBox || !this._windowsBox.get_stage())
                continue;

            let preview = new WindowPreview(window);
            preview.connect('clicked', () => {
                this._workspace.activate(0);
                window.activate(0);
            });
            this._windowPreviews.set(window, preview);
            this._windowsBox.add_child(preview);
        }

        this._mode = 'direct';
        this._updateThumbnailSize();
    }

    _updateThumbnailSize() {
        let iconSize = 96;
        const count = this._windowPreviews.size;

        if (count >= 7) iconSize = 48;
        else if (count >= 5) iconSize = 72;

        for (let preview of this._windowPreviews.values()) {
            if (preview.icon_size !== iconSize) {
                preview.icon_size = iconSize;
                preview._updateIcon();
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

        for (const [, id] of this._addWindowTimeoutIds)
            GLib.Source.remove(id);
        this._addWindowTimeoutIds.clear();

        if (this._wsChangedId && WorkspaceManager) {
            WorkspaceManager.disconnect(this._wsChangedId);
            this._wsChangedId = null;
        }

        if (this._collectionIcon) {
            this._collectionIcon.destroy();
            this._collectionIcon = null;
        }

        ThumbnailRegistry.unregister(this);

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

        journal(`Enabled`);

        // Workspace indicator in top bar
        this._indicator = new WorkspaceIndicator();
        Main.panel.addToStatusArea('workspace-indicator', this._indicator, 0, 'left');

        // Native title-bar drag -> drop on workspace thumbnail
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