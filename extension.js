import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WorkspaceIndicator } from './lib/workspaceIndicator.js';
import { TitleBarMoveMonitor } from './lib/titleBarMoveMonitor.js';

import {
    initLogging,
    createLogger,
} from './logger.js';

const journal = createLogger(import.meta.url);

export default class TopNotchWorkspaces extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._titleBarMoveMonitor = null;
    }

    enable() {
        initLogging(this.uuid, 'file', false);
        journal(`Enabled`);

        const settings = this.getSettings(); // Reads settings-schema from metadata.json

        this._indicator = new WorkspaceIndicator(settings);
        Main.panel.addToStatusArea('workspace-indicator', this._indicator, 0, 'left');

        this._titleBarMoveMonitor = new TitleBarMoveMonitor();
    }

    disable() {
        if (this._titleBarMoveMonitor) {
            this._titleBarMoveMonitor.destroy();
            this._titleBarMoveMonitor = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}