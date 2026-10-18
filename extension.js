import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
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
import { scrollModelWindows } from './lib/workspaceActions.js';

import { initLogging, createLogger } from './logger.js';

const journal = createLogger(import.meta.url);

// Minimum time between two accepted scroll steps. One wheel flick fires
// several SCROLL events; this collapses them into one window change.
const SCROLL_THROTTLE_MS = 150;

export default class TopNotchWorkspaces extends Extension {
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

        // Scroll on the top bar steps through the active workspace's windows
        // in the indicator's visual order.
        this._lastScrollTime = 0;
        Main.panel.connectObject('scroll-event',
            (_actor, event) => this._handleScroll(event), this);
    }

    disable() {
        Main.panel.disconnectObject(this);

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

    // ---------------------------------------------------------------------
    // Top-bar scroll: cycle focus through the active workspace's windows,
    // in model order (the same order the indicator strip renders).
    //
    // Only discrete SCROLL events are handled — touchpad SMOOTH deltas
    // stream too heavily to debounce reliably, so they fall through.
    // ---------------------------------------------------------------------
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

        const now = GLib.get_monotonic_time() / 1000; // ms
        if (now - this._lastScrollTime < SCROLL_THROTTLE_MS)
            return Clutter.EVENT_STOP;
        this._lastScrollTime = now;

        scrollModelWindows(step);
        return Clutter.EVENT_STOP;
    }
}