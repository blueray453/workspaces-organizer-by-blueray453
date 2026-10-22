// ===== FILE: ./extension.js =====
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as ExtensionModule from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { WorkspaceIndicator } from './lib/workspaceIndicator.js';
import { TitleBarMoveMonitor } from './lib/titleBarMoveMonitor.js';
import { PinnedEdgeFlyout } from './lib/pinnedEdgeFlyout.js';
import { EdgeHud } from './lib/edgeHud.js';
import * as OverlayService from './lib/overlayService.js';
import * as DBusService from './lib/dbusService.js';
import * as Interactions from './lib/interactions.js';
import * as Model from './lib/model.js';
import * as WorkspaceActions from './lib/workspaceActions.js';
import * as Sizes from './lib/sizes.js';
import * as Theme from './lib/theme.js';

import { initExternalDrag, destroyExternalDrag } from './lib/externalDrag.js';
import { initFocusedWindowBorder, destroyFocusedWindowBorder } from './lib/focusedWindowBorder.js';
import { initSelectedWindows, destroySelectedWindows } from './lib/selectedWindows.js';

import { initLogging, createLogger } from './logger.js';

const journal = createLogger(import.meta.url);

const SCROLL_THROTTLE_MS = 150;

export default class TopNotchWorkspaces extends ExtensionModule.Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._titleBarMoveMonitor = null;
        this._pinnedEdgeFlyout = null;
        this._edgeHud = null;
        this._lastScrollTime = 0;
        this._unsubSizes = null;
    }

    enable() {
        initLogging(this.uuid, 'file', false);
        journal(`Enabled`);

        const settings = this.getSettings();

        Sizes.initSizes(settings);
        Theme.initTheme(settings);
        this._unsubSizes = Sizes.onSizesChanged(() => {
            Theme.refreshTheme();
            Model.requestRender();
        });

        Model.connectModelSignals(settings);
        initExternalDrag();
        initFocusedWindowBorder();
        initSelectedWindows();

        OverlayService.initOverlayService(settings);
        DBusService.initDBusService();
        DBusService.installCli(this.path);

        this._indicator = new WorkspaceIndicator(settings, {
            showAllApps: OverlayService.showAllApps,
            showAllWindows: OverlayService.showAllWindows,
            showWorkspaceWindows: OverlayService.showWorkspaceWindows,
            showGroupWindows: OverlayService.showGroupWindows,
        });
        Main.panel.addToStatusArea('workspace-indicator', this._indicator, 0, 'left');

        this._titleBarMoveMonitor = new TitleBarMoveMonitor();
        this._pinnedEdgeFlyout = new PinnedEdgeFlyout(settings, {
            onShowApps: OverlayService.showAllApps,
        });
        this._edgeHud = new EdgeHud(settings);

        this._lastScrollTime = 0;
        Main.panel.connectObject('scroll-event',
            (_actor, event) => this._handleScroll(event), this);
    }

    disable() {
        Main.panel.disconnectObject(this);

        DBusService.removeCli(this.path);
        DBusService.destroyDBusService();
        OverlayService.destroyOverlayService();

        if (this._pinnedEdgeFlyout) {
            this._pinnedEdgeFlyout.destroy();
            this._pinnedEdgeFlyout = null;
        }
        if (this._titleBarMoveMonitor) {
            this._titleBarMoveMonitor.destroy();
            this._titleBarMoveMonitor = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._edgeHud) {
            this._edgeHud.destroy();
            this._edgeHud = null;
        }

        destroySelectedWindows();
        destroyFocusedWindowBorder();
        destroyExternalDrag();
        Model.disconnectModelSignals();
        Interactions.destroyTooltip();

        this._unsubSizes?.(); this._unsubSizes = null;
        Theme.destroyTheme();
        Sizes.destroySizes();
    }

    _handleScroll(event) {
        if (event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;

        let step;
        switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
            case Clutter.ScrollDirection.LEFT:
                step = -1; break;
            case Clutter.ScrollDirection.DOWN:
            case Clutter.ScrollDirection.RIGHT:
                step = 1; break;
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