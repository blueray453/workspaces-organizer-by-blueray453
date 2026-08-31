import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { WorkspaceManager, Display } from './shellGlobals.js';
import { WorkspaceThumbnail } from './workspaceThumbnail.js';
import { WindowSearchOverlay } from './windowSearchOverlay.js';
import { AppSearchOverlay } from './appSearchOverlay.js';

import { PanelMenuButton } from './menuHelpers.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

export class WorkspaceIndicator extends PanelMenuButton {
    static { GObject.registerClass(this); }

    constructor(settings) {
        super(0.0, _('Workspace Indicator'));
        this.reactive = false;
        this._settings = settings;

        this._sessionModeId = Main.sessionMode.connect('updated', () => {
            journal('[WorkspaceIndicator] session mode updated, rebuilding thumbnails');
            this._updateThumbnails();
        });

        this._mainBox = new St.BoxLayout({ style_class: 'workspace-indicator-main-box', y_expand: true, x_expand: true, reactive: true });

        this._drunIcon = new St.Icon({
            icon_name: 'view-app-grid-symbolic',
            icon_size: this._settings.get_int('toolbar-icon-size'),
        });
        this._windowIcon = new St.Icon({
            icon_name: 'focus-windows-symbolic',
            icon_size: this._settings.get_int('toolbar-icon-size'),
        });

        this._drunButton = this._makeToolbarButton(this._drunIcon, 'Show apps', () => this._showAllApps());
        this._windowButton = this._makeToolbarButton(this._windowIcon, 'All windows', () => this._showAllWindows());

        this._workspaceName = new St.Label({
            style_class: 'workspace-name-label',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            text: this._getCurrentWorkspaceName(),
        });
        this._updateWorkspaceNameFontSize();

        this._thumbnailsBox = new St.BoxLayout({ style_class: 'workspace-indicator-class', y_expand: true, x_expand: true, reactive: true });

        this._mainBox.add_child(this._drunButton);
        this._mainBox.add_child(this._windowButton);
        this._mainBox.add_child(this._workspaceName);
        this._mainBox.add_child(this._thumbnailsBox);
        this.add_child(this._mainBox);

        this._workspaceManagerSignals = [
            WorkspaceManager.connect_after('notify::n-workspaces', this._updateThumbnails.bind(this)),
            WorkspaceManager.connect_after('workspace-switched', this._onWorkspaceSwitched.bind(this)),
        ];

        this._settingsChangeIds = [
            this._settings.connect('changed::workspace-name-font-size', () => this._updateWorkspaceNameFontSize()),
            this._settings.connect('changed::show-drun-button', () => this._syncVisibility()),
            this._settings.connect('changed::show-window-button', () => this._syncVisibility()),
            this._settings.connect('changed::show-workspace-names', () => this._syncVisibility()),
            this._settings.connect('changed::toolbar-icon-size', () => this._updateToolbarIconSize()),
        ];

        this._syncVisibility();
        this._updateThumbnails();
    }

    _makeToolbarButton(iconActor, accessibleName, onClicked) {
        const button = new St.Button({
            style_class: 'workspace-toolbar-button',
            accessible_name: accessibleName,
            can_focus: true,
            track_hover: true,
            child: iconActor,
        });
        button.connect('clicked', onClicked);
        return button;
    }

    _updateToolbarIconSize() {
        const size = this._settings.get_int('toolbar-icon-size');
        this._drunIcon.icon_size = size;
        this._windowIcon.icon_size = size;
    }

    // Opens the same in-process overlay WindowOverflowButton uses, but
    // fed every window on every workspace instead of a single
    // thumbnail's. No subprocess, no D-Bus, no dependency on the
    // `gdmenu` CLI/extension being installed — direct reuse of
    // WindowSearchOverlay's search/preview/activate/drag logic.
    _showAllWindows() {
        const windows = Display.get_tab_list(Meta.TabList.NORMAL, null);
        new WindowSearchOverlay(windows, this._settings);
    }

    _showAllApps() {
        new AppSearchOverlay(this._settings);
    }

    _syncVisibility() {
        this._drunButton.visible = this._settings.get_boolean('show-drun-button');
        this._windowButton.visible = this._settings.get_boolean('show-window-button');
        this._workspaceName.visible = this._settings.get_boolean('show-workspace-names');
    }

    _getCurrentWorkspaceName() {
        return Meta.prefs_get_workspace_name(WorkspaceManager.get_active_workspace_index());
    }

    _updateWorkspaceNameFontSize() {
        this._workspaceName.set_style(`font-size: ${this._settings.get_int('workspace-name-font-size')}px;`);
    }

    _onWorkspaceSwitched() {
        this._workspaceName.set_text(this._getCurrentWorkspaceName());
        this._updateActiveThumbnail();
    }

    _updateActiveThumbnail() {
        const thumbs = this._thumbnailsBox.get_children();
        for (let i = 0; i < thumbs.length; i++) {
            if (i === WorkspaceManager.get_active_workspace_index()) thumbs[i].add_style_class_name('active');
            else thumbs[i].remove_style_class_name('active');
        }
    }

    _updateThumbnails() {
        this._thumbnailsBox.destroy_all_children();
        for (let i = 0; i < WorkspaceManager.n_workspaces; i++)
            this._thumbnailsBox.add_child(new WorkspaceThumbnail(WorkspaceManager.get_workspace_by_index(i), this._settings));
        this._updateActiveThumbnail();
    }

    cleanupSources() {
        for (const thumb of this._thumbnailsBox.get_children())
            thumb.cleanupSources?.();
    }

    destroy() {
        for (const id of this._settingsChangeIds) this._settings.disconnect(id);
        this._settingsChangeIds = [];

        this.cleanupSources();
        this._thumbnailsBox?.destroy();
        for (const id of this._workspaceManagerSignals) WorkspaceManager.disconnect(id);
        Main.panel.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = null;
        }

        super.destroy();
    }
}