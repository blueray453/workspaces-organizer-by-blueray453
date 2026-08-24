import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { fuzzyMatch } from './fuzzySearch.js';
import { createClonePreviewActor } from './clonePreviewActor.js';
import { WindowReorderDragController } from './windowReorderDragController.js';

import { WindowTracker } from './shellGlobals.js';

import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

export class WindowSearchOverlay {
    constructor(windows, settings) {
        journal(`[WindowSearchOverlay] Opening with ${windows.length} windows`);
        this._windows = windows;
        this._settings = settings;
        this._results = [];
        this._resultButtons = [];
        this._selectedIndex = -1;
        this._previewClone = null;
        this._modalGrab = null;
        this._closed = false;
        this._buildUI();
        this._setResults(this._getAllResultsSorted());
        this._open();
    }

    _getAppName(window) {
        const app = WindowTracker.get_window_app(window);
        return app ? app.get_name() : (window.get_wm_class() || 'Unknown');
    }

    _getAppIcon(window) {
        const app = WindowTracker.get_window_app(window);
        if (app) {
            const icon = app.get_icon();
            if (icon)
                return icon;
        }
        return Gio.ThemedIcon.new('application-x-executable');
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
        journal(`[WindowSearchOverlay] Sorted Results ${items} windows`);
        return items;
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        this._container = new St.Widget({
            style_class: 'window-collection-overlay',
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });

        const margin = 40;
        const entryHeight = 60;
        const entryGap = 20;
        const panelWidth = monitor.width - margin * 2;
        const panelX = monitor.x + margin;
        const entryY = monitor.y + margin;
        const panelTop = entryY + entryHeight + entryGap;
        const panelHeight = monitor.height - (panelTop - monitor.y) - margin;
        const resultsWidth = Math.round(panelWidth * 0.32);
        const previewWidth = panelWidth - resultsWidth - 20;

        this._entry = new St.Entry({
            style_class: 'collection-search-entry',
            hint_text: 'Search windows…',
            can_focus: true,
            x: panelX,
            y: entryY,
            width: panelWidth,
            height: entryHeight,
        });
        this._entry.set_style(`font-size: ${this._settings.get_int('collection-search-font-size')}pt;`);

        this._resultsScroll = new St.ScrollView({
            style_class: 'collection-results-scroll',
            x: panelX,
            y: panelTop,
            width: resultsWidth,
            height: panelHeight,
        });
        this._resultsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        this._resultsBox = new St.BoxLayout({
            style_class: 'collection-results-box',
            vertical: true,
            x_expand: true,
        });
        this._resultsScroll.set_child(this._resultsBox);

        this._previewBox = new St.BoxLayout({
            style_class: 'collection-preview-box',
            x: panelX + resultsWidth + 20,
            y: panelTop,
            width: previewWidth,
            height: panelHeight,
        });

        this._container.add_child(this._entry);
        this._container.add_child(this._resultsScroll);
        this._container.add_child(this._previewBox);

        this._entryChangedId = this._entry.clutter_text.connect('text-changed',
            () => this._onSearchChanged());
        this._entryKeyPressId = this._entry.clutter_text.connect('key-press-event',
            (actor, event) => this._onKeyPress(event));

        journal(`[WindowSearchOverlay] Build UI End`);
    }

    _open() {
        Main.layoutManager.addChrome(this._container, {
            affectsInputRegion: true,
            trackFullscreen: true,
        });
        Main.layoutManager.uiGroup.set_child_above_sibling(this._container, null);
        this._modalGrab = Main.pushModal(this._container, {
            actionMode: Shell.ActionMode.NORMAL,
        });
        this._entry.grab_key_focus();
    }

    _close() {
        if (this._closed) return;
        this._closed = true;
        journal(`[WindowSearchOverlay] Closing`);
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
        this._container.destroy();
    }

    _onSearchChanged() {
        if (this._closed) return;
        const query = this._entry.get_text();
        const all = this._getAllResultsSorted();
        if (!query.trim()) {
            this._setResults(all);
            return;
        }
        const scored = [];
        for (const item of all) {
            const label = `${item.title} — ${item.appName}`;
            const result = fuzzyMatch(query, label);
            if (result.matched)
                scored.push({ ...item, score: result.score });
        }
        scored.sort((a, b) => b.score - a.score);
        this._setResults(scored);
    }

    _setResults(results) {
        this._results = results;
        this._resultsBox.destroy_all_children();
        this._resultButtons = [];
        this._selectedIndex = -1;

        results.forEach((item, index) => {
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

            // Give this drag its own small flying actor instead of dragging
            // the full result row — matches the look of dragging an actual
            // workspace-thumbnail icon. getDragActor() is called by dnd.js
            // synchronously right after 'drag-begin' fires, so registering
            // with WindowReorderDragController.beginDrag() here (rather than
            // in the 'drag-begin' handler below) is what makes the
            // reorder-drag-source styling and drag-placeholder-icon cloning
            // available for this actor at all.
            button.getDragActorSource = () => button;
            button.getDragActor = () => {
                const iconSize = this._settings.get_int('icon-size');
                const dragIcon = this._buildDragIconActor(item.icon, iconSize);
                WindowReorderDragController.beginDrag(dragIcon);
                return dragIcon;
            };

            const draggable = DND.makeDraggable(button, { restoreOnSuccess: false });
            button._draggable = draggable;
            draggable.connect('drag-begin', () => this._onResultDragBegin(button));
            draggable.connect('drag-end', () => {
                WindowReorderDragController.endDrag();
            });

            button.connect('clicked', () => this._activateResult(index));
            button.connect('notify::hover', () => {
                if (button.hover)
                    this._selectIndex(index);
            });

            this._resultsBox.add_child(button);
            this._resultButtons.push(button);
        });

        if (results.length > 0)
            this._selectIndex(0);
        else
            this._clearPreview();
    }

    _selectIndex(index) {
        if (this._closed) return;
        if (index < 0 || index >= this._results.length)
            return;
        if (this._selectedIndex >= 0 && this._resultButtons[this._selectedIndex])
            this._resultButtons[this._selectedIndex].remove_style_class_name('selected');
        this._selectedIndex = index;
        this._resultButtons[index]?.add_style_class_name('selected');
        this._updatePreview(this._results[index].window);
    }

    _updatePreview(window) {
        this._clearPreview();
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
        this._previewClone = built.actor;
    }

    _clearPreview() {
        if (!this._previewClone)
            return;
        if (this._previewClone.get_parent() === this._previewBox)
            this._previewBox.remove_child(this._previewClone);
        this._previewClone.destroy();
        this._previewClone = null;
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

    _onKeyPress(event) {
        if (this._closed) return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        switch (symbol) {
            case Clutter.KEY_Escape:
                this._close();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                if (this._selectedIndex < this._results.length - 1)
                    this._selectIndex(this._selectedIndex + 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
                if (this._selectedIndex > 0)
                    this._selectIndex(this._selectedIndex - 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
                if (this._selectedIndex >= 0)
                    this._activateResult(this._selectedIndex);
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }

    _buildDragIconActor(gicon, iconSize) {
        const dragIcon = new St.Bin({
            style_class: 'window-preview-icon',
            width: iconSize,
            height: iconSize,
        });
        // Plain property, not a declared GObject prop — same pattern
        // WindowIconButton uses for `this.icon_size`. Read by
        // WindowReorderDragController._ensurePlaceholder() to size the
        // cloned placeholder it drops into the target box.
        dragIcon.icon_size = iconSize;
        if (gicon) {
            dragIcon.set_child(new St.Icon({ gicon, icon_size: iconSize }));
        }
        return dragIcon;
    }
}