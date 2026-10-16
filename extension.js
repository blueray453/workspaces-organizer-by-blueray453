import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { WorkspaceIndicator, TitleBarMoveMonitor } from './lib/workspaceIndicator.js';
import {
    initOverlayService, destroyOverlayService,
    showAllApps, showAllWindows, showWorkspaceWindows,
} from './lib/overlayService.js';
import { initDBusService, destroyDBusService } from './lib/dbusService.js';
import { destroyTooltip } from './lib/interactions.js';
import { connectModelSignals, disconnectModelSignals } from './lib/model.js';

import { initLogging, createLogger } from './logger.js';

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

        const settings = this.getSettings();

        // Model owns its own world/state subscriptions.
        connectModelSignals(settings);

        // Overlay logic first so _settings is set before any DBus handler
        // can fire; the DBus adapter is a pure transport on top of it.
        initOverlayService(settings);
        initDBusService();

        // Composition root: the indicator is given the overlay entry points
        // as plain callbacks. It never imports overlayService.
        this._indicator = new WorkspaceIndicator(settings, {
            showAllApps,
            showAllWindows,
            showWorkspaceWindows,
        });
        Main.panel.addToStatusArea('workspace-indicator', this._indicator, 0, 'left');

        this._titleBarMoveMonitor = new TitleBarMoveMonitor();
    }

    disable() {
        destroyDBusService();
        destroyOverlayService();

        if (this._titleBarMoveMonitor) {
            this._titleBarMoveMonitor.destroy();
            this._titleBarMoveMonitor = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        disconnectModelSignals();
        destroyTooltip();
    }
}