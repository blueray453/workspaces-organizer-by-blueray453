import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Meta from 'gi://Meta';
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
        this._delegate = this;
        DND.makeDraggable(this, { restoreOnSuccess: true });

        this._window = window;
        this.icon_size = 64;

        this._updateIcon();

        this._wmClassChangedId = this._window.connect('notify::wm-class',
            this._updateIcon.bind(this));
        this._mappedId = this._window.connect('notify::mapped',
            this._updateIcon.bind(this));

        // Single hover signal handler
        this._hoverSignalId = this.connect('notify::hover', () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                if (this.hover) {
                    // Show preview immediately when hovered
                    this._showHoverPreview();
                } else {
                    // When unhovered, check if we're hovering over the preview
                    if (!this._hoverPreview || !this._hoverPreview.hover) {
                        this._hideHoverPreview();
                    }
                    // If we are hovering over the preview, don't hide - wait for preview's hover signal
                }

                return GLib.SOURCE_REMOVE;
            });
        });

        this._buttonPressedId = this.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                let menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP, 0);
                let manager = new PopupMenu.PopupMenuManager(this);
                manager.addMenu(menu);
                Main.uiGroup.add_child(menu.actor);

                let activateItem = new PopupMenu.PopupMenuItem(`Activate ${this._window.title}`);
                activateItem.connect('activate', () => {
                    let win_workspace = this._window.get_workspace();
                    win_workspace.activate_with_focus(this._window, 0);
                });
                menu.addMenuItem(activateItem);

                let closeItem = new PopupMenu.PopupMenuItem(`Close ${this._window.title}`);
                closeItem.connect('activate', () => this._window.delete(0));
                menu.addMenuItem(closeItem);

                let closeAllItem = new PopupMenu.PopupMenuItem(`Close all windows on workspace ${this._window.get_workspace().index()}`);
                closeAllItem.connect('activate', () => {
                    let windows = this._window.get_workspace().list_windows();
                    windows.forEach(window => {
                        if (window.get_window_type() === 0) {
                            journal(`Closing window: ${window.get_title()}`);
                            window.delete(0);
                        }
                    });
                });
                menu.addMenuItem(closeAllItem);

                // ADD THESE 6 LINES FOR DESKTOP ACTIONS
                const app = WindowTracker.get_window_app(this._window);
                const appInfo = app?.get_app_info();
                appInfo?.list_actions().forEach(action => {
                    let item = new PopupMenu.PopupMenuItem(appInfo.get_action_name(action));
                    // https://gjs-docs.gnome.org/shell16~16/shell.app#method-launch_action
                    item.connect('activate', () => app.launch_action(action, 0, -1));
                    menu.addMenuItem(item);
                });
                // END OF ADDED CODE

                menu.open(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._wsChangedId = WorkspaceManager.connect(
            'workspace-switched',
            () => this._hideHoverPreview()
        );
    }

    _showHoverPreview() {
        if (!this._window || this._hoverPreview) return;

        const windowActor = this._window.get_compositor_private();
        if (!windowActor) return;

        const actorWidth = this.get_width();
        const [actorX, actorY] = this.get_transformed_position();

        const windowWidth = windowActor.width;
        const windowHeight = windowActor.height;

        const aspectRatio = windowWidth / windowHeight;
        const previewHeight = 800;
        const previewWidth = previewHeight * aspectRatio;

        let previewX = actorX + (actorWidth - previewWidth) / 2;
        const previewY = actorY - previewHeight - 40;

        previewX = Math.max(0, previewX);

        journal(`previewX: ${previewX}`);
        journal(`previewY: ${previewY}`);

        // Create wrapper with hover tracking
        const wrapper = new St.BoxLayout({
            style_class: 'hover-preview-wrapper',
            x: previewX,
            y: previewY,
            width: previewWidth + 8,
            height: previewHeight,
            reactive: true,
            track_hover: true,  // Track hover on preview too
        });

        // Connect preview's hover signal
        wrapper.connect('notify::hover', () => {
            if (!wrapper.hover && !this.hover) {
                // Neither button nor preview is hovered - hide the preview
                this._hideHoverPreview();
            }
        });

        // Add click handler
        wrapper.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                let win_workspace = this._window.get_workspace();
                win_workspace.activate_with_focus(this._window, 0);
                this._hideHoverPreview();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Create the clone
        const clone = new Clutter.Clone({
            source: windowActor,
            width: previewWidth,
            height: previewHeight,
            reactive: false,
        });

        // Pack clone inside wrapper
        wrapper.add_child(clone);
        this._hoverPreview = wrapper;

        this._hoverPreview.opacity = 0;
        Main.layoutManager.addChrome(this._hoverPreview);

        this._hoverPreview.ease({
            opacity: 255,
            duration: 600,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hideHoverPreview() {
        if (!this._hoverPreview) return;

        // Remove the hover signal from preview before destroying
        const wrapper = this._hoverPreview;
        this._hoverPreview = null;

        Main.layoutManager.removeChrome(wrapper);
        wrapper.destroy();
    }

    // needed for DND
    get realWindow() {
        return this._window.get_compositor_private();
    }

    _updateIcon() {
        const app = Shell.WindowTracker.get_default().get_window_app(this._window) ||
            Shell.AppSystem.get_default().lookup_app(this._window.get_wm_class());
        if (app && app.get_app_info().get_icon()) {
            this.set_child(app.create_icon_texture(this.icon_size));
        } else {
            let gicon = this._window.get_gicon();
            if (!gicon) {
                gicon = new Gio.ThemedIcon({ name: 'applications-system-symbolic' });
            }
            const icon = new St.Icon({
                gicon: gicon,
                style_class: 'popup-menu-icon'
            });
            this.set_child(St.TextureCache.get_default().load_gicon(null, icon, this.icon_size));
        }
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

        /* disconnect workspace-changed */
        if (this._wsChangedId && WorkspaceManager) {
            WorkspaceManager.disconnect(this._wsChangedId);
            this._wsChangedId = null;
        }

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

        this.set_child(this._windowsBox);

        this._delegate = this; // needed for DND

        this._windowPreviews = new Map();
        this._addWindowTimeoutIds = new Map();

        this._workspace = workspace;

        this.connect('button-press-event', (actor, event) => {
            let button = event.get_button();

            if (button === Clutter.BUTTON_PRIMARY) { // left click
                this._workspace.activate(0);
                return Clutter.EVENT_STOP; // prevent default
            }

            if (button === Clutter.BUTTON_SECONDARY) { // right click
                let windows = this._workspace.list_windows().filter(w =>
                    w.get_window_type() === 0
                );

                const windowCount = windows.length;

                if (windowCount === 0) {
                    return Clutter.EVENT_STOP; // Fix: Return STOP to prevent menu creation
                }

                let menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP, 0);

                // menu.removeAll();

                let manager = new PopupMenu.PopupMenuManager(this);
                manager.addMenu(menu);
                Main.uiGroup.add_child(menu.actor);

                let closeAllItem = new PopupMenu.PopupMenuItem(`Close all windows on workspace ${this._workspace.index()}`);
                menu.addMenuItem(closeAllItem);

                closeAllItem.connect('activate', () => {
                    windows.forEach(window => {
                        journal(`Closing window: ${window.get_title()}`);
                        window.delete(0);
                    });
                });

                menu.open(true);
                return Clutter.EVENT_STOP; // prevent default
            }

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
                this._workspace.activate(0);
                window.activate(0);
            });
            this._windowPreviews.set(window, preview);
            // Double check container is still valid  before adding
            if (this._windowsBox && this._windowsBox.get_stage())
                this._windowsBox.add_child(preview);
            else
                preview.destroy();

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
