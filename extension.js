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

// Represents a single window icon inside a workspace thumbnail.
class WindowPreview extends St.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(window) {
        super({
            reactive: true,
            track_hover: true,  // Enable built-in hover tracking
        });

        this._hoverPreview = null;
        this._titlePopup = null;

        this._hoverTimeoutId = null;

        this._delegate = this;
        DND.makeDraggable(this, { restoreOnSuccess: true });

        this._window = window;
        this.icon_size = 96;

        this._updateIcon();

        this._wmClassChangedId = this._window.connect('notify::wm-class',
            this._updateIcon.bind(this));
        this._mappedId = this._window.connect('notify::mapped',
            this._updateIcon.bind(this));

        // Single hover signal handler
        this._hoverSignalId = this.connect('notify::hover', () => {
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }

            this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
                this._hoverTimeoutId = null;
                if (this.hover) {
                    // Check for Ctrl key when hovered
                    const [, , mods] = global.get_pointer();
                    const ctrlDown = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;

                    // journal(`[WindowPreview] Hover started with Ctrl: ${ctrlDown}, hoverPreview: ${!!this._hoverPreview}, titlePopup: ${!!this._titlePopup}`);

                    if (ctrlDown) {
                        // Hide hover preview if it exists
                        this._hideHoverPreview();
                        // Show title popup when Ctrl is held
                        this._showTitlePopup();
                    } else {
                        // Hide title popup if it exists
                        this._hideTitlePopup();
                        // Show regular preview when no Ctrl key
                        this._showHoverPreview();
                    }
                } else {
                    // journal(`[WindowPreview] Hover ended, hoverPreview: ${!!this._hoverPreview}, titlePopup: ${!!this._titlePopup}`);
                    // When unhovered, check if we're hovering over the preview
                    if (this._hoverPreview && !this._hoverPreview.hover) {
                        // journal(`[WindowPreview] HoverPreview not hovered, hiding it`);
                        this._hideHoverPreview();
                    }
                    if (this._titlePopup && !this._titlePopup.hover) {
                        // journal(`[WindowPreview] TitlePopup not hovered, hiding it`);
                        this._hideTitlePopup();
                    }
                    // If we are hovering over the preview, don't hide - wait for preview's hover signal
                }

                return GLib.SOURCE_REMOVE;
            });
        });

        this._buttonPressedId = this.connect('button-press-event', (actor, event) => {

            let button = event.get_button();

            if (button === Clutter.BUTTON_PRIMARY) {
                this._hideHoverPreview();
                this._hideTitlePopup();

                const win = this._window;
                const currentWs = WorkspaceManager.get_active_workspace();
                const winWs = win.get_workspace();

                if (winWs === currentWs) {
                    // window is on current workspace → toggle minimize
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
                // Window is on different workspace - switch to it
                winWs.activate_with_focus(win, 0);
                return Clutter.EVENT_STOP;
            }

            if (button === Clutter.BUTTON_SECONDARY) {
                // journal(`[WindowPreview] Right click detected, hiding all previews`);
                let menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP);
                this._contextMenu = menu; // keep a reference
                let manager = new PopupMenu.PopupMenuManager(this);
                manager.addMenu(menu);
                Main.uiGroup.add_child(menu.actor);
                // journal(`Main.uiGroup: ${Main.uiGroup.get_compositor_private()}`);
                // Main.panel._menus.addMenu(menu);

                menu.addAction(`Activate ${this._window.title}`, () => {
                    let win_workspace = this._window.get_workspace();
                    win_workspace.activate_with_focus(this._window, 0);
                });

                menu.addAction(`Close ${this._window.title}`, () => {
                    this._window.delete(0);
                });

                // menu.addAction(`Close all windows on workspace ${this._window.get_workspace().index()}`, () => {
                //     let windows = this._window.get_workspace().list_windows();
                //     windows.forEach(window => {
                //         if (window.get_window_type() === 0) {
                //             journal(`Closing window: ${window.get_title()}`);
                //             window.delete(0);
                //         }
                //     });
                // });

                // ADD THESE LINES FOR DESKTOP ACTIONS
                const app = WindowTracker.get_window_app(this._window);
                const appInfo = app?.get_app_info();
                const actions = appInfo?.list_actions();

                // Only add desktop actions if there are more than 0 actions
                if (actions && actions.length > 0) {
                    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    actions.forEach(action => {

                        menu.addAction(`${appInfo.get_action_name(action)}`, () => {
                            // https://gjs-docs.gnome.org/shell16~16/shell.app#method-launch_action
                            app.launch_action(action, 0, -1)
                        });
                    });
                }

                menu.open(true);

                if (menu._boxPointer) {
                    menu._boxPointer.translation_y = -35;
                }

                return Clutter.EVENT_STOP;
            }
        });

        this._wsChangedId = WorkspaceManager.connect('workspace-switched', () => {
            // journal(`[WindowPreview] Workspace switched, hiding all previews`);
            this._hideAllPreviews();
            // this._hideHoverPreview();
            // this._hideTitlePopup();
            if (this._contextMenu) {
                this._contextMenu.close();
                this._contextMenu = null;
            }
        });
    }

    _is_covered(window) {
        if (window.minimized) { return false; }
        let current_workspace = WorkspaceManager.get_active_workspace();

        // Get windows on the current workspace in stacking order
        let windows_by_stacking = Display.sort_windows_by_stacking(global.get_window_actors().map(actor => actor.meta_window).filter(win => win.get_window_type() === Meta.WindowType.NORMAL)).filter(win =>
            win.get_workspace() === current_workspace
        );

        // // Find the target window
        // let targetWin = windows_by_stacking.find(win => win.get_id() === window.get_id());
        // if (!targetWin) return false;
        let targetRect = window.get_frame_rect();
        let targetIndex = windows_by_stacking.indexOf(window);
        journal(`${targetIndex}`);

        // Check only windows above the target in stacking order
        for (let i = targetIndex + 1; i < windows_by_stacking.length; i++) {
            let topWin = windows_by_stacking[i];
            let topRect = topWin.get_frame_rect();

            // Check if topWin fully covers window
            if (
                topRect.x <= targetRect.x &&
                topRect.y <= targetRect.y &&
                topRect.x + topRect.width >= targetRect.x + targetRect.width &&
                topRect.y + topRect.height >= targetRect.y + targetRect.height
            ) {
                return true;
            }
        }

        return false; // no window fully covers it
    }

    // _showHoverPreview() {
    //     if (!this._window) return;

    //     const windowActor = this._window.get_compositor_private();
    //     if (!windowActor) return;

    //     // const allocation = this.get_allocation_box();
    //     // const actorWidth = allocation.get_width();
    //     const actorWidth = this.get_width();
    //     journal(`actorWidth : ${actorWidth}`);
    //     const [actorX, actorY] = this.get_transformed_position();

    //     const windowFrame = this._window.get_frame_rect();
    //     const windowWidth = windowFrame.width;
    //     const windowHeight = windowFrame.height;

    //     const aspectRatio = windowWidth / windowHeight;

    //     const previewHeight = 600; // fixed
    //     const previewWidth = previewHeight * aspectRatio;

    //     // Directly above the actor (no gap)
    //     const previewX = actorX + (actorWidth - previewWidth) / 2;
    //     const previewY = actorY - previewHeight - 20; // 20px gap above window

    //     this._hoverPreview = new Clutter.Clone({
    //         source: windowActor,
    //         x: previewX,
    //         y: previewY,
    //         width: previewWidth,
    //         height: previewHeight
    //     });

    //     Main.layoutManager.addChrome(this._hoverPreview);
    // }

    // _showHoverPreview() {
    //     if (!this._window || this._hoverPreview) return;

    //     const windowActor = this._window.get_compositor_private();
    //     if (!windowActor) return;

    //     const windowPreviewWidth = this.get_width();
    //     const [windowPreviewX, windowPreviewY] = this.get_transformed_position();

    //     const windowActorWidth = windowActor.width;
    //     const windowActorHeight = windowActor.height;

    //     const windowActorAspectRatio = windowActorWidth / windowActorHeight;
    //     const previewHeight = 800;
    //     const previewWidth = previewHeight * windowActorAspectRatio;

    //     let previewX = windowPreviewX + (windowPreviewWidth - previewWidth) / 2;
    //     const previewY = windowPreviewY - previewHeight - 40;

    //     previewX = Math.max(0, previewX);

    //     journal(`previewX: ${previewX}`);
    //     journal(`previewY: ${previewY}`);

    //     // Create wrapper with hover tracking
    //     const wrapper = new St.BoxLayout({
    //         style_class: 'hover-preview-wrapper',
    //         x: previewX,
    //         y: previewY,
    //         width: previewWidth + 8,
    //         height: previewHeight,
    //         reactive: true,
    //         track_hover: true,  // Track hover on preview too
    //     });

    //     // Connect preview's hover signal
    //     wrapper.connect('notify::hover', () => {
    //         if (!wrapper.hover && !this.hover) {
    //             // Neither button nor preview is hovered - hide the preview
    //             this._hideHoverPreview();
    //         }
    //     });

    //     // Add click handler
    //     wrapper.connect('button-press-event', (actor, event) => {
    //         if (event.get_button() === Clutter.BUTTON_PRIMARY) {
    //             let win_workspace = this._window.get_workspace();
    //             win_workspace.activate_with_focus(this._window, 0);
    //             this._hideHoverPreview();
    //             return Clutter.EVENT_STOP;
    //         }
    //         return Clutter.EVENT_PROPAGATE;
    //     });

    //     // Create the clone
    //     const clone = new Clutter.Clone({
    //         source: windowActor,
    //         width: previewWidth,
    //         height: previewHeight,
    //         reactive: false,
    //     });

    //     // Pack clone inside wrapper
    //     wrapper.add_child(clone);
    //     this._hoverPreview = wrapper;

    //     this._hoverPreview.opacity = 0;
    //     Main.layoutManager.addChrome(this._hoverPreview);

    //     this._hoverPreview.ease({
    //         opacity: 255,
    //         duration: 600,
    //         mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    //     });
    // }

    _showHoverPreview() {
        // Early exit conditions
        if (!this._window || this._hoverPreview) {
            // journal(`[WindowPreview] _showHoverPreview: Cannot show - window: ${!!this._window}, hoverPreview: ${!!this._hoverPreview}`);
            return;
        }

        // journal(`[WindowPreview] _showHoverPreview: Starting - titlePopup exists: ${!!this._titlePopup}`);

        // === Clone Code ===
        const windowPreviewWidth = this.get_width();
        const [windowPreviewX, windowPreviewY] = this.get_transformed_position();
        // The visible frame rectangle of the window (excluding shadows)
        const windowFrame = this._window.get_frame_rect();

        // Calculate preview dimensions
        const previewHeight = 800;
        const previewWidth = previewHeight * (windowFrame.width / windowFrame.height);

        // Calculate preview position
        let previewX = Math.max(0, windowPreviewX + (windowPreviewWidth - previewWidth) / 2);
        const previewY = windowPreviewY - previewHeight - 64;

        // Calculate scaled shadows
        // The full buffer (including shadows)
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

        // === ADD CLOSE BUTTON ===
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

        // Position close button at top-right corner
        closeButton.set_position(previewWidth - 60, 10);

        closeButton.connect('clicked', () => {
            this._window.delete(global.get_current_time());
            this._hideHoverPreview();
            return Clutter.EVENT_STOP;
        });
        // === END CLOSE BUTTON ===

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

        // Show and animate preview
        this._hoverPreview = outerWrapper;
        this._hoverPreview.opacity = 0;
        Main.layoutManager.addChrome(this._hoverPreview);

        this._hoverPreview.ease({
            opacity: 255,
            duration: 600,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Track wrapper hover timeout
        let wrapperHoverTimeoutId = null;

        // Event handlers
        outerWrapper.connect('notify::hover', () => {
            // journal(`[WindowPreview] HoverPreview hover changed: ${outerWrapper.hover}, button hover: ${this.hover}`);

            // Clear any existing timeout
            if (wrapperHoverTimeoutId) {
                GLib.source_remove(wrapperHoverTimeoutId);
                wrapperHoverTimeoutId = null;
            }

            if (!outerWrapper.hover && !this.hover) {
                wrapperHoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
                    wrapperHoverTimeoutId = null;
                    if (!outerWrapper.hover && !this.hover) {
                        // journal(`[WindowPreview] HoverPreview timeout - hiding preview`);
                        this._hideHoverPreview();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        outerWrapper.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._window.get_workspace().activate_with_focus(this._window, 0);
                this._hideHoverPreview();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // // this.set_can_focus(true);
        // this.grab_key_focus();

        // this.connect('key-press-event', (actor, event) => {
        //     const key = event.get_key_symbol();

        //     if ((key === Clutter.KEY_Control_L || key === Clutter.KEY_Control_R) && this._hoverPreview) {
        //         // Hide current thumbnail
        //         this._hideHoverPreview();
        //         // Show title popup instead
        //         this._showTitlePopup();
        //         return Clutter.EVENT_STOP;
        //     }

        //     return Clutter.EVENT_PROPAGATE;
        // });

        // journal(`[WindowPreview] _showHoverPreview: Completed successfully`);
    }

    // _showTitlePopup() is a fallback hover UI.

    // When you hover a window preview while holding Ctrl,
    // instead of showing the big live window preview,
    // this function shows a small text label with the window title.

    // However it creates a bug due to the use of grab_key_focus
    // Some keybindings stop working.
    // This is why removing this feature

    _showTitlePopup() {
        // Don't show if already showing or no window
        if (!this._window || this._titlePopup) {
            // journal(`[WindowPreview] _showTitlePopup: Cannot show - window: ${!!this._window}, titlePopup: ${!!this._titlePopup}`);
            return;
        }

        // journal(`[WindowPreview] _showTitlePopup: Starting - hoverPreview exists: ${!!this._hoverPreview}`);

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

        // For consistency with your API:
        this._titlePopup = label;

        Main.layoutManager.addChrome(label);

        label.opacity = 0;
        label.ease({
            opacity: 255,
            duration: TimeoutDelay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Hide when mouse leaves both icon and label
        label.connect("notify::hover", () => {
            if (!label.hover && !this.hover) {
                // journal(`[WindowPreview] TitlePopup not hovered, hiding it`);
                this._hideTitlePopup();
            }
        });

        // // label.set_can_focus(true);
        // label.grab_key_focus();

        // label.connect('key-release-event', (actor, event) => {
        //     const key = event.get_key_symbol();
        //     if (key === Clutter.KEY_Control_L || key === Clutter.KEY_Control_R) {
        //         this._hideTitlePopup();
        //         this._showHoverPreview();
        //     }
        //     return Clutter.EVENT_PROPAGATE;
        // });

        journal(`[WindowPreview] _showTitlePopup: Completed successfully`);
    }

    _hideHoverPreview() {
        if (!this._hoverPreview) {
            // journal(`[WindowPreview] _hideHoverPreview: No hoverPreview to hide`);
            return;
        }

        // journal(`[WindowPreview] _hideHoverPreview: Hiding hoverPreview`);

        // Remove the hover signal from preview before destroying
        const wrapper = this._hoverPreview;
        this._hoverPreview = null;

        Main.layoutManager.removeChrome(wrapper);
        wrapper.destroy();
    }

    _hideTitlePopup() {
        if (!this._titlePopup) {
            // journal(`[WindowPreview] _hideTitlePopup: No titlePopup to hide`);
            return;
        }

        // journal(`[WindowPreview] _hideTitlePopup: Hiding titlePopup`);

        const popup = this._titlePopup;
        this._titlePopup = null;

        Main.layoutManager.removeChrome(popup);
        popup.destroy();
    }

    _hideAllPreviews() {
        // journal(`[WindowPreview] _hideAllPreviews: Hiding all previews`);
        this._hideHoverPreview();
        this._hideTitlePopup();
    }

    // needed for DND
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

        // let rect = new Mtk.Rectangle();
        // [rect.x, rect.y] = [0, global.screen_height];
        // [rect.width, rect.height] = [0,0];
        // this._window.set_icon_geometry(rect);

        // // Wait for the next tick to ensure icon is properly positioned
        // this._updateIconIdleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        //     if (!iconActor) {
        //         return GLib.SOURCE_REMOVE; // exit early, nothing to do
        //     }

        //     if (!iconActor.get_stage()) return GLib.SOURCE_CONTINUE;

        //     const rect = new Mtk.Rectangle();
        //     [rect.x, rect.y] = iconActor.get_transformed_position();
        //     [rect.width, rect.height] = iconActor.get_transformed_size();
        //     this._window.set_icon_geometry(rect);
        //     return GLib.SOURCE_REMOVE;
        // });


        iconActor.connect('stage-views-changed', (actor) => {
            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = iconActor.get_transformed_position();
            [rect.width, rect.height] = iconActor.get_transformed_size();
            this._window.set_icon_geometry(rect);

            iconActor.disconnect(id);
        });
    }

    destroy() {
        // Disconnect the single hover signal
        if (this._hoverSignalId) {
            this.disconnect(this._hoverSignalId);
            this._hoverSignalId = null;
        }

        if (this._hoverPreview) {
            this._hideHoverPreview();
        }

        /* disconnect window signal: wm-class */
        if (this._wmClassChangedId && this._window) {
            this._window.disconnect(this._wmClassChangedId);
            this._wmClassChangedId = null;
        }

        /* disconnect window signal: mapped */
        if (this._mappedId && this._window) {
            this._window.disconnect(this._mappedId);
            this._mappedId = null;
        }

        if (this._buttonPressedId) {
            this.disconnect(this._buttonPressedId);
            this._mappedId = null;
        }

        if (this._wsChangedId && WorkspaceManager) {
            WorkspaceManager.disconnect(this._wsChangedId);
            this._wsChangedId = null;
        }

        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        this._hideAllPreviews();

        super.destroy();
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
