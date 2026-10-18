import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as ExtensionModule from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as WorkspaceIndicatorModule from './lib/workspaceIndicator.js';
import * as OverlayService from './lib/overlayService.js';
import * as DBusService from './lib/dbusService.js';
import * as Interactions from './lib/interactions.js';
import * as Model from './lib/model.js';
import * as WorkspaceActions from './lib/workspaceActions.js';

import { initLogging, createLogger } from './logger.js';

const journal = createLogger(import.meta.url);

// Minimum time between two accepted scroll steps.
const SCROLL_THROTTLE_MS = 150;

export default class TopNotchWorkspaces extends ExtensionModule.Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._titleBarMoveMonitor = null;
        this._lastScrollTime = 0;
    }

    enable() {
        initLogging(this.uuid, 'file', false);
        journal(`Enabled`);

        const settings = this.getSettings();

        Model.connectModelSignals(settings);

        OverlayService.initOverlayService(settings);
        DBusService.initDBusService();

        this._indicator = new WorkspaceIndicatorModule.WorkspaceIndicator(settings, {
            showAllApps: OverlayService.showAllApps,
            showAllWindows: OverlayService.showAllWindows,
            showWorkspaceWindows: OverlayService.showWorkspaceWindows,
        });
        Main.panel.addToStatusArea('workspace-indicator', this._indicator, 0, 'left');

        this._titleBarMoveMonitor = new WorkspaceIndicatorModule.TitleBarMoveMonitor();

        this._lastScrollTime = 0;
        Main.panel.connectObject('scroll-event',
            (_actor, event) => this._handleScroll(event), this);
    }

    disable() {
        Main.panel.disconnectObject(this);

        DBusService.destroyDBusService();
        OverlayService.destroyOverlayService();

        if (this._titleBarMoveMonitor) {
            this._titleBarMoveMonitor.destroy();
            this._titleBarMoveMonitor = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        Model.disconnectModelSignals();
        Interactions.destroyTooltip();
    }

    // Top-bar scroll: cycle focus through the active workspace's windows in
    // model order. No-ops when the workspace is in overflow mode (the model
    // reports `direct = false`, i.e. >5 windows) — the strip shows a count
    // button, so there's no per-window order to walk.
    _handleScroll(event) {
        if (event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;

        let step;
        switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
            case Clutter.ScrollDirection.LEFT:
                step = -1;
                break;
            case Clutter.ScrollDirection.DOWN:
            case Clutter.ScrollDirection.RIGHT:
                step = 1;
                break;
            default:
                return Clutter.EVENT_PROPAGATE;
        }

        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastScrollTime < SCROLL_THROTTLE_MS)
            return Clutter.EVENT_STOP;
        this._lastScrollTime = now;

        WorkspaceActions.scrollModelWindows(step);
        return Clutter.EVENT_STOP;
    }
}