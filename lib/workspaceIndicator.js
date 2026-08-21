import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Meta from 'gi://Meta';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { WorkspaceManager } from './shellGlobals.js';
import { WorkspaceThumbnail } from './workspaceThumbnail.js';

export class WorkspaceIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super(0.0, _('Workspace Indicator'));
        this.reactive = false;
        this._settings = settings;

        this._mainBox = new St.BoxLayout({
            style_class: 'workspace-indicator-main-box',
            y_expand: true,
            x_expand: true,
            reactive: true,
        });

        this._workspaceName = new St.Label({
            style_class: 'workspace-name-label',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            text: this._getCurrentWorkspaceName(),
        });
        this._updateWorkspaceNameFontSize();

        this._thumbnailsBox = new St.BoxLayout({
            style_class: 'workspace-indicator-class',
            y_expand: true,
            x_expand: true,
            reactive: true,
        });

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

        // Listen for changes to the workspace name font size
        this._settingsChangeId = this._settings.connect('changed::workspace-name-font-size', () => {
            this._updateWorkspaceNameFontSize();
        });

        this._updateThumbnails();
    }

    _getCurrentWorkspaceName() {
        const currentWorkspace = WorkspaceManager.get_active_workspace_index();
        return Meta.prefs_get_workspace_name(currentWorkspace);
    }

    _updateWorkspaceNameFontSize() {
        const fontSize = this._settings.get_int('workspace-name-font-size');
        this._workspaceName.set_style(`font-size: ${fontSize}px;`);
    }

    _onWorkspaceSwitched() {
        this._workspaceName.set_text(this._getCurrentWorkspaceName());
        this._updateActiveThumbnail();
    }

    _updateActiveThumbnail() {
        const thumbs = this._thumbnailsBox.get_children();
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
            const thumb = new WorkspaceThumbnail(
                WorkspaceManager.get_workspace_by_index(i),
                this._settings
            );
            this._thumbnailsBox.add_child(thumb);
        }
        this._updateActiveThumbnail();
    }

    cleanupSources() {
        const thumbs = this._thumbnailsBox.get_children();
        for (const thumb of thumbs) {
            if (typeof thumb.cleanupSources === 'function')
                thumb.cleanupSources();
        }
    }

    destroy() {
        // Disconnect the settings signal
        if (this._settingsChangeId) {
            this._settings.disconnect(this._settingsChangeId);
            this._settingsChangeId = null;
        }

        this.cleanupSources();
        this._thumbnailsBox?.destroy();
        for (const id of this._workspaceManagerSignals)
            WorkspaceManager.disconnect(id);
        Main.panel.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        super.destroy();
    }
}