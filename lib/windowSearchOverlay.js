import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SearchOverlayBase } from './searchOverlayBase.js';
import { createClonePreviewActor } from './clonePreviewActor.js';
import { getWindowAppIcon } from './windowIconTexture.js';
import { DragSession } from './dragSession.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';

import { WindowTracker } from './shellGlobals.js';

import { createReorderDraggable } from './dragHelpers.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const NEMO_WM_CLASS = 'Nemo';
const FILE_PROGRESS_INSTANCE = 'file_progress';

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
        const filtered = this._windows.filter(w => w && !w.skip_taskbar);
        const deduped = this._dedupeNemoWindows(filtered);

        const items = deduped.map(w => ({
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

    _dedupeNemoWindows(windows) {
        const keptByTitle = new Map();
        const result = [];

        for (const w of windows) {
            const isNemo = w.get_wm_class() === NEMO_WM_CLASS;
            const isProgress = w.get_wm_class_instance() === FILE_PROGRESS_INSTANCE;

            if (!isNemo || isProgress) {
                result.push(w);
                continue;
            }

            const key = w.get_title();
            const existing = keptByTitle.get(key);

            if (!existing) {
                keptByTitle.set(key, w);
                result.push(w);
                continue;
            }

            if (w.get_user_time() > existing.get_user_time()) {
                const idx = result.indexOf(existing);
                if (idx !== -1) result.splice(idx, 1);
                journal(`[WindowSearchOverlay] Closing duplicate Nemo window: "${existing.get_title()}"`);
                existing.delete(0);
                keptByTitle.set(key, w);
                result.push(w);
            } else {
                journal(`[WindowSearchOverlay] Closing duplicate Nemo window: "${w.get_title()}"`);
                w.delete(0);
            }
        }

        return result;
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
            DragSession.ghostTemplate = dragIcon;
            if (typeof dragIcon.add_style_class_name === 'function')
                dragIcon.add_style_class_name('reorder-drag-source');
            return dragIcon;
        };

        const draggable = createReorderDraggable(button, this._settings.get_int('icon-size'));

        button._draggable = draggable;
        draggable.connect('drag-begin', () => this._onResultDragBegin(button));
        draggable.connect('drag-end', () => {
            DragSession.ghostTemplate = null;
            WorkspaceThumbnailRegistry.hideAllGhosts();
            WorkspaceThumbnailRegistry.hideAllNameHints();
            if (button) {
                try { button.remove_style_class_name('reorder-drag-source'); }
                catch (e) { /* button may already be destroyed */ }
            }
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

    // -------------------- DnD lifecycle --------------------
    // Both the drag-begin and drag-end paths now defer their side effects
    // to an idle. The Shell DnD system installs its own stage grab during
    // drag-begin and releases it during drag-end. Doing a `popModal` or a
    // container `destroy()` synchronously from inside those signals races
    // with that grab setup/teardown and can leave the stage grab stuck,
    // which freezes the cursor.
    //
    // So: on drag-begin we register the drag-end listener immediately
    // (we can't miss it), but schedule the visible teardown to an idle.
    // On drag-end we schedule the container destroy to an idle too.
    // ---------------------------------------------------------

    _onResultDragBegin(button) {
        if (this._closed) return;
        this._closed = true;
        journal(`[WindowSearchOverlay] Drag started on result — closing overlay, drag continues`);

        // Register the drag-end listener now — synchronously — so we don't
        // miss the event. The teardown it schedules runs on an idle later.
        const draggable = button._draggable;
        if (draggable) {
            const endId = draggable.connect('drag-end', () => {
                draggable.disconnect(endId);
                journal(`[WindowSearchOverlay] Drag finished, disposing overlay`);
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._destroyContainerAfterDrag();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } else {
            // Should not happen — _onResultDragBegin is only called from a
            // draggable's drag-begin. Defensive fallback, still deferred.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._destroyContainerAfterDrag();
                return GLib.SOURCE_REMOVE;
            });
        }

        // Defer the modal pop and overlay hide to an idle. This runs after
        // the Shell DnD's own grab setup for this same drag-begin emission
        // has completed.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._teardownVisibleOverlay();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Deferred from _onResultDragBegin. Hides the overlay and releases
    // its modal grab. Idempotent — safe to run once, safe to run after
    // the container has already been destroyed.
    _teardownVisibleOverlay() {
        if (!this._container) return;

        this._clearPreview();

        if (this._modalGrab) {
            Main.popModal(this._modalGrab);
            this._modalGrab = null;
        }

        if (this._entry?.clutter_text) {
            if (this._entryChangedId) {
                this._entry.clutter_text.disconnect(this._entryChangedId);
                this._entryChangedId = null;
            }
            if (this._entryKeyPressId) {
                this._entry.clutter_text.disconnect(this._entryKeyPressId);
                this._entryKeyPressId = null;
            }
        }

        Main.layoutManager.removeChrome(this._container);
        this._container.hide();
    }

    // Deferred from the drag-end listener registered in
    // _onResultDragBegin. Destroys the overlay's actor tree. Idempotent.
    _destroyContainerAfterDrag() {
        if (this._modalGrab) {
            Main.popModal(this._modalGrab);
            this._modalGrab = null;
        }
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
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