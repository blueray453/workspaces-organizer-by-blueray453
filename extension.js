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

const WorkspaceManager = global.workspace_manager;
const Display = global.display;

// Represents a single window icon inside a workspace thumbnail.
class WindowPreview extends St.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(window) {
        super({
            style_class: 'workspace-indicator-window-preview',
        });

        this._hoverPreview = null;

        this._delegate = this;
        DND.makeDraggable(this, { restoreOnSuccess: true });

        this._window = window;

        /* Use a smaller icon to allow more previews to fit in a workspace */
        this.icon_size = 64;

        this._updateIcon();

        this._wmClassChangedId = this._window.connect('notify::wm-class',
            this._updateIcon.bind(this));
        this._mappedId = this._window.connect('notify::mapped',
            this._updateIcon.bind(this));

        this.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                let menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP, 0);
                let manager = new PopupMenu.PopupMenuManager(this);
                manager.addMenu(menu);
                Main.uiGroup.add_child(menu.actor);

                let closeItem = new PopupMenu.PopupMenuItem(`Close ${this._window.title}`);

                closeItem.connect('activate', () => this._window.delete(0));
                menu.addMenuItem(closeItem);

                let activateItem = new PopupMenu.PopupMenuItem(`Activate ${this._window.title}`);

                activateItem.connect('activate', () => {
                    let win_workspace = this._window.get_workspace();
                    // Here global.get_current_time() instead of 0 will also work
                    win_workspace.activate_with_focus(this._window, 0);
                });

                menu.addMenuItem(activateItem);

                let closeAllItem = new PopupMenu.PopupMenuItem(`Close all windows on workspace ${this._window.get_workspace().index()}`);
                menu.addMenuItem(closeAllItem);

                closeAllItem.connect('activate', () => {
                    let windows = this._window.get_workspace().list_windows();
                    windows.forEach(window => {
                        if (window.get_window_type() === 0) {
                            journal(`Closing window: ${window.get_title()}`);
                            window.delete(0);
                        }
                    });
                });

                menu.open(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Connect hover signals
        this._enterEventId = this.connect('enter-event', () => this._showHoverPreview());
        this._leaveEventId = this.connect('leave-event', () => this._hideHoverPreview());
        this._destroyEventId = this.connect('destroy', () => {
            this._window.disconnect(this._wmClassChangedId);
            this._window.disconnect(this._mappedId);
            this._hideHoverPreview();
        });
        this._wsChangedId = WorkspaceManager.connect(
            'workspace-switched',
            () => this._hideHoverPreview()
        );

    }

    _showHoverPreview() {
        if (!this._window || this._hoverPreview || this._hoverTimeout) return;

        this._hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._hoverTimeout = null;

            const windowActor = this._window.get_compositor_private();
                if (!windowActor) return GLib.SOURCE_REMOVE;

            // const allocation = this.get_allocation_box();
            // const actorWidth = allocation.get_width();
            const actorWidth = this.get_width();
            journal(`actorWidth : ${actorWidth}`);
            const [actorX, actorY] = this.get_transformed_position();

            const windowFrame = this._window.get_frame_rect();
            const windowWidth = windowFrame.width;
            const windowHeight = windowFrame.height;

            const aspectRatio = windowWidth / windowHeight;

            const previewHeight = 600; // fixed
            const previewWidth = previewHeight * aspectRatio;

            // Directly above the actor (no gap)
            const previewX = actorX + (actorWidth - previewWidth) / 2;
            const previewY = actorY - previewHeight - 40; // 20px gap above window

            this._hoverPreview = new Clutter.Clone({
                source: windowActor,
                x: previewX,
                y: previewY,
                width: previewWidth,
                height: previewHeight,
                reactive: false // ensures it does not block hover leave
            });

            // Main.layoutManager.addChrome(this._hoverPreview);

            this._hoverPreview.opacity = 0;
            Main.layoutManager.addChrome(this._hoverPreview);
            this._hoverPreview.ease({
                opacity: 255,
                duration: 600,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideHoverPreview() {

        if (this._hoverTimeout) {
            GLib.source_remove(this._hoverTimeout);
            this._hoverTimeout = null;
        }

        if (!this._hoverPreview) return;

        // this._hoverPreview.ease({
        //     opacity: 0,
        //     duration: 300,
        //     mode: Clutter.AnimationMode.EASE_IN_QUAD,
        //     onComplete: () => {
        //         Main.layoutManager.removeChrome(this._hoverPreview);
        //         this._hoverPreview.destroy();
        //         this._hoverPreview = null;
        //     }
        // });

        if (this._hoverPreview) {
            Main.layoutManager.removeChrome(this._hoverPreview);
            this._hoverPreview.destroy();
            this._hoverPreview = null;
        }
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
        // Disconnect preview signals
        if (this._enterEventId) {
            this.disconnect(this._enterEventId);
            this._enterEventId = null;
        }

        if (this._leaveEventId) {
            this.disconnect(this._leaveEventId);
            this._leaveEventId = null;
        }

        if (this._destroyEventId) {
            this.disconnect(this._destroyEventId);
            this._destroyEventId = null;
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

    constructor(index) {
        super({
            style_class: 'workspace',
            x_expand: true,
            y_expand: true,
        });

        this._windowsBox = new St.BoxLayout({
            style_class: 'workspace-windows',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.set_child(this._windowsBox);

        this._index = index;
        this._delegate = this; // needed for DND

        this._windowPreviews = new Map();
        this._addWindowTimeoutIds = new Map();

        this._workspace = WorkspaceManager.get_workspace_by_index(index);

        this.connect('button-press-event', (actor, event) => {
            let button = event.get_button();

            if (button === Clutter.BUTTON_PRIMARY) { // left click
                let ws = WorkspaceManager.get_workspace_by_index(this._index);
                if (ws)
                    ws.activate(0);
                return Clutter.EVENT_STOP; // prevent default
            }

            if (button === Clutter.BUTTON_SECONDARY) { // right click
                journal(`Right click detected on workspace ${this._index}!`);
                let windows = this._workspace.list_windows().filter(w =>
                    w.get_window_type() === 0
                );

                const windowCount = windows.length;

                if (windowCount === 0) {
                    return
                }

                let menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP, 0);

                // menu.removeAll();

                let manager = new PopupMenu.PopupMenuManager(this);
                manager.addMenu(menu);
                Main.uiGroup.add_child(menu.actor);

                let closeAllItem = new PopupMenu.PopupMenuItem(`Close all windows on workspace ${this._index}`);
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
            return Clutter.EVENT_PROPAGATE;
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
        window.change_workspace_by_index(this._index, false);
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

        let container = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.add_child(container);

        this._currentWorkspace = WorkspaceManager.get_active_workspace_index();
        this._statusLabel = new St.Label({
            style_class: 'panel-workspace-indicator',
            y_align: Clutter.ActorAlign.CENTER,
            text: this._labelText(),
        });

        container.add_child(this._statusLabel);

        this._thumbnailsBox = new St.BoxLayout({
            style_class: 'panel-workspace-indicator-box',
            y_expand: true,
            x_expand: true,
            reactive: true,
        });

        container.add_child(this._thumbnailsBox);

        this._workspacesItems = [];
        this._workspaceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._workspaceSection);

        this._workspaceManagerSignals = [
            WorkspaceManager.connect_after('notify::n-workspaces',
                this._nWorkspacesChanged.bind(this)),
            WorkspaceManager.connect_after('workspace-switched',
                this._onWorkspaceSwitched.bind(this)),
            WorkspaceManager.connect('notify::layout-rows',
                this._onWorkspaceOrientationChanged.bind(this)),
        ];

        this._createWorkspacesSection();
        this._updateThumbnails();
        this._onWorkspaceOrientationChanged();
    }

    destroy() {
        this.cleanupSources();
        this._thumbnailsBox?.destroy();

        for (let i = 0; i < this._workspaceManagerSignals.length; i++)
            WorkspaceManager.disconnect(this._workspaceManagerSignals[i]);

        Main.panel.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

        super.destroy();
    }

    _onWorkspaceOrientationChanged() {
        let vertical = WorkspaceManager.layout_rows === -1;
        this.reactive = vertical;

        this._statusLabel.visible = vertical;
        this._thumbnailsBox.visible = !vertical;

        // Disable offscreen-redirect when showing the workspace switcher
        // so that clip-to-allocation works
        Main.panel.set_offscreen_redirect(vertical
            ? Clutter.OffscreenRedirect.ALWAYS
            : Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY);
    }

    _onWorkspaceSwitched() {
        this._currentWorkspace = WorkspaceManager.get_active_workspace_index();

        this._updateMenuOrnament();
        this._updateActiveThumbnail();

        this._statusLabel.set_text(this._labelText());
    }

    _nWorkspacesChanged() {
        this._createWorkspacesSection();
        this._updateThumbnails();
    }

    _updateMenuOrnament() {
        for (let i = 0; i < this._workspacesItems.length; i++) {
            this._workspacesItems[i].setOrnament(i === this._currentWorkspace
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }
    }

    _updateActiveThumbnail() {
        let thumbs = this._thumbnailsBox.get_children();
        for (let i = 0; i < thumbs.length; i++) {
            if (i === this._currentWorkspace)
                thumbs[i].add_style_class_name('active');
            else
                thumbs[i].remove_style_class_name('active');
        }
    }

    _labelText(workspaceIndex) {
        if (workspaceIndex === undefined) {
            workspaceIndex = this._currentWorkspace;
            return (workspaceIndex + 1).toString();
        }
        return Meta.prefs_get_workspace_name(workspaceIndex);
    }

    _createWorkspacesSection() {
        this._workspaceSection.removeAll();
        this._workspacesItems = [];
        this._currentWorkspace = WorkspaceManager.get_active_workspace_index();

        let i = 0;
        for (; i < WorkspaceManager.n_workspaces; i++) {
            this._workspacesItems[i] = new PopupMenu.PopupMenuItem(this._labelText(i));
            this._workspaceSection.addMenuItem(this._workspacesItems[i]);
            this._workspacesItems[i].workspaceId = i;
            this._workspacesItems[i].label_actor = this._statusLabel;
            this._workspacesItems[i].connect('activate', (actor, _event) => {
                this._activate(actor.workspaceId);
            });

            if (i === this._currentWorkspace)
                this._workspacesItems[i].setOrnament(PopupMenu.Ornament.DOT);
        }

        this._statusLabel.set_text(this._labelText());
    }

    _updateThumbnails() {
        this._thumbnailsBox.destroy_all_children();

        for (let i = 0; i < WorkspaceManager.n_workspaces; i++) {
            let thumb = new WorkspaceThumbnail(i);
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

    _activate(index) {
        if (index >= 0 && index < WorkspaceManager.n_workspaces) {
            let metaWorkspace = WorkspaceManager.get_workspace_by_index(index);
            metaWorkspace.activate(0);
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
        Main.panel.addToStatusArea('workspace-indicator', this._indicator, 0, 'center');
    }

    disable() {
        // Destroy workspace indicator
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
