import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SearchOverlayBase } from './searchOverlayBase.js';
import { createClonePreviewActor } from './clonePreviewActor.js';
import { getWindowAppIcon } from './windowIconTexture.js';
import { WindowReorderDragController } from './windowReorderDragController.js';
import { WindowTracker } from './shellGlobals.js';
import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

export class WindowSearchOverlay extends SearchOverlayBase {
    constructor(windows, settings) {
        super(settings);
        journal(`[WindowSearchOverlay] Opening with ${windows.length} windows`);
        this._windows = windows;
        this._buildUI();
        this._setResults(this._getAllResultsSorted());
        this._open();
    }

    // -------------------- Base hooks --------------------
    _getHintText() { return 'Search windows…'; }
    _getSearchLabel(item) { return `${item.title} — ${item.appName}`; }

    // -------------------- Windows --------------------
    _getAppName(window) {
        const app = WindowTracker.get_window_app(window);
        return app ? app.get_name() : (window.get_wm_class() || 'Unknown');
    }

    _getAppIcon(window) {
        return getWindowAppIcon(window);
    }

    _getAllResultsSorted() {
        const items = this._windows
            .filter(w => w && !w.skip_taskbar)
            .map(w => ({
                window: w,
                title: w.get_title() || 'Untitled Window',
                appName: this._getAppName(w),
                icon: this._getAppIcon(w),
            }));
        items.sort((a, b) => {
            const appCompare = a.appName.localeCompare(b.appName);
            if (appCompare !== 0)
                return appCompare;
            return a.title.localeCompare(b.title);
        });
        journal(`[WindowSearchOverlay] Sorted Results ${items.length} windows`);
        return items;
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        const margin = 40;
        const entryHeight = 80;
        const entryGap = 20;
        const panelWidth = monitor.width - margin * 2;
        const panelX = monitor.x + margin;
        const entryY = monitor.y + margin;
        const panelTop = entryY + entryHeight + entryGap;
        const panelHeight = monitor.height - (panelTop - monitor.y) - margin;
        const resultsWidth = Math.round(panelWidth * 0.32);
        const previewWidth = panelWidth - resultsWidth - 20;
        const layout = { monitor, margin, entryHeight, entryGap, panelWidth, panelX, entryY, panelTop, panelHeight, resultsWidth, previewWidth };

        this._buildContainer(layout.monitor);
        this._buildEntry(layout);
        this._buildResultsAndPreview(layout);

        this._container.add_child(this._entry);
        this._container.add_child(this._resultsScroll);
        this._container.add_child(this._previewBox);

        journal(`[WindowSearchOverlay] Build UI End`);
    }

    _close() {
        if (this._closed) return;
        journal(`[WindowSearchOverlay] Closing`);
        super._close();
    }

    // -------------------- Results --------------------
    _buildResultRow(item, index) {
        const button = new St.Button({
            style_class: 'collection-result-item',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            track_hover: true,
            reactive: true,
        });
        button.set_style(`font-size: ${this._settings.get_int('collection-result-font-size')}pt;`);

        const row = new St.BoxLayout({ vertical: false, x_expand: true });

        if (item.icon) {
            const iconSize = this._settings.get_int('collection-result-icon-size');
            row.add_child(new St.Icon({
                gicon: item.icon,
                style_class: 'collection-result-icon',
                icon_size: iconSize,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        row.add_child(new St.Label({
            text: `${item.title}  —  ${item.appName}`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        button.set_child(row);

        button._delegate = button;
        button.realWindow = item.window.get_compositor_private();

        button.getDragActorSource = () => button;
        button.getDragActor = () => {
            const iconSize = this._settings.get_int('icon-size');
            const dragIcon = this._buildDragIconActor(item.icon, iconSize);
            WindowReorderDragController.beginDrag(dragIcon, item.window);
            return dragIcon;
        };

        const draggable = DND.makeDraggable(button, { restoreOnSuccess: false });
        button._draggable = draggable;
        draggable.connect('drag-begin', () => this._onResultDragBegin(button));
        draggable.connect('drag-end', () => {
            WindowReorderDragController.endDrag();
        });

        return button;
    }

    _updatePreviewContent(item) {
        const window = item.window;
        const windowFrame = window.get_frame_rect();
        if (windowFrame.height === 0) return;

        const aspect = windowFrame.width / windowFrame.height;
        let targetHeight = this._previewBox.height;
        let targetWidth = targetHeight * aspect;

        if (targetWidth > this._previewBox.width) {
            targetWidth = this._previewBox.width;
            targetHeight = targetWidth / aspect;
        }

        const built = createClonePreviewActor(window, targetHeight, {
            onClose: (win) => this._closeWindowFromPreview(win),
            closeButtonSize: this._settings.get_int('close-button-size'),
            titleFontSize: this._settings.get_int('clone-title-font-size'),
        });
        if (!built) return;

        built.actor.set_position(
            Math.max(0, (this._previewBox.width - built.width) / 2),
            Math.max(0, (this._previewBox.height - built.height) / 2)
        );

        this._previewBox.add_child(built.actor);
        this._previewContent = built.actor;
    }

    _closeWindowFromPreview(window) {
        if (this._closed) return;
        journal(`[WindowSearchOverlay] Closing window from preview: ${window.title}`);
        window.delete(global.get_current_time());

        const closedIndex = this._results.findIndex(item => item.window === window);
        if (closedIndex === -1)
            return;

        this._results.splice(closedIndex, 1);
        this._windows = this._windows.filter(w => w !== window);

        const button = this._resultButtons[closedIndex];
        if (button) {
            if (button.get_parent() === this._resultsBox)
                this._resultsBox.remove_child(button);
            button.destroy();
        }
        this._resultButtons.splice(closedIndex, 1);

        if (this._results.length === 0) {
            this._selectedIndex = -1;
            this._clearPreview();
            return;
        }

        const nextIndex = Math.min(closedIndex, this._results.length - 1);
        this._selectedIndex = -1;
        this._selectIndex(nextIndex);
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (!item)
            return;
        const window = item.window;
        journal(`[WindowSearchOverlay] Activating: ${window.title}`);
        if (window.minimized)
            window.unminimize();
        window.get_workspace().activate_with_focus(window, global.get_current_time());
        this._close();
    }

    _onResultDragBegin(button) {
        if (this._closed)
            return;
        this._closed = true;
        journal(`[WindowSearchOverlay] Drag started on result — closing overlay, drag continues`);
        this._clearPreview();
        if (this._modalGrab) {
            Main.popModal(this._modalGrab);
            this._modalGrab = null;
        }
        if (this._entry?.clutter_text) {
            this._entry.clutter_text.disconnect(this._entryChangedId);
            this._entry.clutter_text.disconnect(this._entryKeyPressId);
        }

        Main.layoutManager.removeChrome(this._container);
        this._container.hide();

        const draggable = button._draggable;
        if (!draggable) {
            this._container.destroy();
            return;
        }

        const endId = draggable.connect('drag-end', () => {
            draggable.disconnect(endId);
            journal(`[WindowSearchOverlay] Drag finished, disposing overlay`);
            this._container.destroy();
        });
    }

    _buildDragIconActor(gicon, iconSize) {
        const dragIcon = new St.Bin({
            style_class: 'window-preview-icon',
            width: iconSize,
            height: iconSize,
        });
        dragIcon.icon_size = iconSize;
        if (gicon) {
            dragIcon.set_child(new St.Icon({ gicon, icon_size: iconSize }));
        }
        return dragIcon;
    }
}
