import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Meta from 'gi://Meta';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { WorkspaceManager } from './shellGlobals.js';
import { WorkspaceThumbnail } from './workspaceThumbnail.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const GDMENU_BIN = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'gdmenu']);

export class WorkspaceIndicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor(settings) {
        super(0.0, _('Workspace Indicator'));
        this.reactive = false;
        this._settings = settings;

        this._mainBox = new St.BoxLayout({ style_class: 'workspace-indicator-main-box', y_expand: true, x_expand: true, reactive: true });

        this._drunButton = this._makeToolbarButton('view-app-grid-symbolic', 'Show apps', () => this._launchGdmenu(['--drun', '--fullscreen']));
        this._windowButton = this._makeToolbarButton('window-symbolic', 'All windows', () => this._launchGdmenu(['--window', '--fullscreen']));

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

        this._workspaceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._workspaceSection);

        this._workspaceManagerSignals = [
            WorkspaceManager.connect_after('notify::n-workspaces', this._updateThumbnails.bind(this)),
            WorkspaceManager.connect_after('workspace-switched', this._onWorkspaceSwitched.bind(this)),
        ];

        this._settingsChangeIds = [
            this._settings.connect('changed::workspace-name-font-size', () => this._updateWorkspaceNameFontSize()),
            // Immediate: no restart needed — just toggle visibility.
            this._settings.connect('changed::show-drun-button', () => this._syncVisibility()),
            this._settings.connect('changed::show-window-button', () => this._syncVisibility()),
            this._settings.connect('changed::show-workspace-names', () => this._syncVisibility()),
        ];

        this._syncVisibility();
        this._updateThumbnails();
    }

    _makeToolbarButton(iconName, accessibleName, onClicked) {
        const button = new St.Button({
            style_class: 'workspace-toolbar-button',
            accessible_name: accessibleName,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({ icon_name: iconName, icon_size: 20 }),
        });
        button.connect('clicked', onClicked);
        return button;
    }

    _launchGdmenu(args) {
        try {
            const proc = Gio.Subprocess.new([GDMENU_BIN, ...args], Gio.SubprocessFlags.NONE);
            proc.wait_async(null, (p, res) => {
                try { p.wait_finish(res); }
                catch (e) { journal(`[WorkspaceIndicator] gdmenu exited with error: ${e.message}`, true); }
            });
        } catch (e) {
            journal(`[WorkspaceIndicator] Failed to launch gdmenu (is the dmenu extension installed?): ${e.message}`, true);
        }
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
        super.destroy();
    }
}