import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { WorkspaceManager, Display, TimeoutDelay, DIRECT_MODE_MAX_WINDOWS } from './shellGlobals.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';
import { WindowReorderDragController } from './windowReorderDragController.js';
import { getDraggedWindow } from './dragHelpers.js';
import { WindowIconButton } from './windowIconButton.js';
import { WindowSearchOverlay } from './windowSearchOverlay.js';

import { FloatingTooltip } from './floatingTooltip.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== WINDOW ORDER STORE ====================
// Pure bookkeeping for one workspace's window list and its user-defined
// display order. WindowReorderDragController is the only external caller
// of _setSuppressSync()/_insertWindowImmediate() — those exist to let it
// perform an atomic cross-thumbnail transplant without a double rebuild.
class WindowOrderStore {
    constructor(workspace) {
        this._workspace = workspace;
        this._order = [];
        this._pendingInsertIndices = new Map();
        this._addWindowTimeoutIds = new Map();
        this._onOrderChanged = null;
        this._suppressSync = false;

        this._windowAddedId = workspace.connect('window-added', (ws, win) => this._addWindow(win));
        this._windowRemovedId = workspace.connect('window-removed', (ws, win) => this._removeWindow(win));
        this._windowCreatedId = Display.connect('window-created', (display, win) => {
            if (win.get_workspace() === this._workspace) this._addWindow(win);
        });

        this._workspace.list_windows().forEach(w => this._addWindow(w));
    }

    get workspace() { return this._workspace; }
    get order() { return this._order; }
    setOnOrderChanged(callback) { this._onOrderChanged = callback; }

    reorderWindowToIndex(window, insertIndex) {
        if (insertIndex === null) return;
        const currentIndex = this._order.indexOf(window);
        if (currentIndex === -1) {
            if (window.get_workspace() === this._workspace) {
                this._order.splice(Math.max(0, Math.min(insertIndex, this._order.length)), 0, window);
                this._emitOrderChanged();
            }
            return;
        }
        this._order.splice(currentIndex, 1);
        this._order.splice(Math.max(0, Math.min(insertIndex, this._order.length)), 0, window);
        this._emitOrderChanged();
    }

    setPendingInsertIndex(window, index) { this._pendingInsertIndices.set(window, index); }

    cleanupSources() {
        for (const [, id] of this._addWindowTimeoutIds) GLib.Source.remove(id);
        this._addWindowTimeoutIds.clear();
    }

    destroy() {
        this.cleanupSources();
        this._pendingInsertIndices.clear();
        if (this._windowAddedId) this._workspace.disconnect(this._windowAddedId);
        if (this._windowRemovedId) this._workspace.disconnect(this._windowRemovedId);
        if (this._windowCreatedId) Display.disconnect(this._windowCreatedId);
    }

    // ---- PRIVATE (but accessible to WindowReorderDragController) ----
    _setSuppressSync(suppress) {
        this._suppressSync = suppress;
    }

    _insertWindowImmediate(window, index) {
        if (this._order.includes(window)) return;
        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }
        this._pendingInsertIndices.delete(window);
        this._order.splice(Math.max(0, Math.min(index, this._order.length)), 0, window);
    }

    // ---- Internal helpers ----
    _addWindow(window) {
        if (window.skip_taskbar) return;
        if (this._order.includes(window)) { this._pendingInsertIndices.delete(window); return; }
        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }
        // Debounced: mutter's frame rect isn't reliably settled the
        // instant window-added fires — this gives it TimeoutDelay to
        // finish before we build an icon from it. Removing this caused
        // intermittent icon-geometry bugs previously; keep it.
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
            this._addWindowTimeoutIds.delete(window);
            if (window.get_workspace() !== this._workspace) return GLib.SOURCE_REMOVE;
            if (!this._order.includes(window)) {
                if (this._pendingInsertIndices.has(window)) {
                    const idx = Math.max(0, Math.min(this._pendingInsertIndices.get(window), this._order.length));
                    this._order.splice(idx, 0, window);
                } else {
                    this._order.push(window);
                }
            }
            this._pendingInsertIndices.delete(window);
            this._emitOrderChanged();
            return GLib.SOURCE_REMOVE;
        });
        this._addWindowTimeoutIds.set(window, sourceId);
    }

    _removeWindow(window) {
        this._pendingInsertIndices.delete(window);
        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }
        const idx = this._order.indexOf(window);
        if (idx === -1) return;
        this._order.splice(idx, 1);
        this._emitOrderChanged();
    }

    _emitOrderChanged() {
        if (!this._suppressSync) this._onOrderChanged?.();
    }
}

// ==================== WINDOW OVERFLOW BUTTON ====================
// The single "N windows" button shown when a thumbnail is over the
// direct-mode threshold. Opens WindowSearchOverlay.
class WindowOverflowButton extends St.Button {
    static { GObject.registerClass(this); }

    constructor(getWindowsFn, settings) {
        super({ style_class: 'workspace-thumbnail-collection-icon', reactive: true, track_hover: true, can_focus: true });
        this._getWindowsFn = getWindowsFn;
        this._settings = settings;
        this._label = new St.Label({ style_class: 'collection-icon-label', y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER });
        this.set_child(this._label);
        this._clickedId = this.connect('clicked', () => new WindowSearchOverlay(this._getWindowsFn(), this._settings));
    }

    setCount(count) { this._label.set_text(`▱ ${count}`); }

    destroy() {
        if (this._clickedId) { this.disconnect(this._clickedId); this._clickedId = null; }
        super.destroy();
    }
}

// ==================== THUMBNAIL DISPLAY MODE CONTROLLER ====================
class ThumbnailDisplayModeController {
    constructor(box, orderStore, settings, { onIconClicked } = {}) {
        this._box = box;
        this._orderStore = orderStore;
        this._settings = settings;
        this._onIconClicked = onIconClicked ?? (() => { });
        this._windowPreviews = new Map();
        this._collectionIcon = null;
        this._mode = 'direct';

        this._settingsChangeId = this._settings.connect('changed::icon-size', () => this._updateAllIconSizes());
        this._orderStore.setOnOrderChanged(() => this._sync());
        this._sync();
    }

    get mode() { return this._mode; }

    wouldStayDirect(prospectiveCount) { return prospectiveCount <= DIRECT_MODE_MAX_WINDOWS; }

    // Public: reorder existing children without rebuilding
    syncChildOrder() {
        if (this._mode !== 'direct' || !this._box) return;
        const orderedPreviews = [];
        for (const window of this._orderStore.order) {
            const preview = this._windowPreviews.get(window);
            if (!preview) continue;
            if (preview.get_parent() === this._box) this._box.remove_child(preview);
            orderedPreviews.push(preview);
        }
        for (const preview of orderedPreviews) this._box.add_child(preview);
    }

    destroy() {
        if (this._settingsChangeId) { this._settings.disconnect(this._settingsChangeId); this._settingsChangeId = null; }
        for (const preview of this._windowPreviews.values()) {
            if (preview.get_parent() === this._box) this._box.remove_child(preview);
            preview.destroy();
        }
        this._windowPreviews.clear();
        if (this._collectionIcon) {
            if (this._collectionIcon.get_parent() === this._box) this._box.remove_child(this._collectionIcon);
            this._collectionIcon.destroy();
            this._collectionIcon = null;
        }
    }

    // ---- PRIVATE rebuild (formerly sync) ----
    _sync() {
        const count = this._orderStore.order.length;
        if (count > DIRECT_MODE_MAX_WINDOWS) this._enterCollectionMode(count);
        else this._enterDirectMode();
    }

    _enterCollectionMode(count) {
        for (const preview of this._windowPreviews.values()) {
            if (preview.get_parent() === this._box) this._box.remove_child(preview);
            preview.destroy();
        }
        this._windowPreviews.clear();
        if (!this._collectionIcon) {
            this._collectionIcon = new WindowOverflowButton(() => this._orderStore.order.slice(), this._settings);
            this._box.add_child(this._collectionIcon);
        }
        this._collectionIcon.setCount(count);
        this._mode = 'collection';
    }

    _enterDirectMode() {
        if (this._collectionIcon) {
            if (this._collectionIcon.get_parent() === this._box) this._box.remove_child(this._collectionIcon);
            this._collectionIcon.destroy();
            this._collectionIcon = null;
        }
        const currentWindows = new Set(this._orderStore.order);
        for (const [window, preview] of this._windowPreviews) {
            if (!currentWindows.has(window)) {
                if (preview.get_parent() === this._box) this._box.remove_child(preview);
                preview.destroy();
                this._windowPreviews.delete(window);
            }
        }
        for (const window of this._orderStore.order) {
            if (this._windowPreviews.has(window)) continue;
            if (!this._box || !this._box.get_stage()) continue;
            const preview = new WindowIconButton(window, this._settings);
            preview.connect('clicked', () => this._onIconClicked(window));
            this._windowPreviews.set(window, preview);
            this._box.add_child(preview);
        }
        this._mode = 'direct';
        this.syncChildOrder();
        this._updateAllIconSizes();
    }

    _updateAllIconSizes() {
        const iconSize = this._settings.get_int('icon-size');
        for (const preview of this._windowPreviews.values()) preview.setIconSize(iconSize);
    }

    // Called by drag controller when a window leaves the workspace
    releasePreview(window) {
        const preview = this._windowPreviews.get(window);
        if (!preview) return null;
        this._windowPreviews.delete(window);
        if (preview.get_parent() === this._box) {
            this._box.remove_child(preview);
        }
        return preview;
    }
}

// ==================== THUMBNAIL ACTION MENU ====================
class ThumbnailActionMenu {
    constructor(workspace, anchorActor) {
        this._workspace = workspace;
        this._anchor = anchorActor;
        this._menu = null;
        this._menuManager = null;
    }

    open() {
        const windows = Display.get_tab_list(Meta.TabList.NORMAL, this._workspace);
        const menu = new PopupMenu.PopupMenu(this._anchor, 0.0, St.Side.TOP);
        menu.box.add_style_class_name('workspace-context-menu');
        this._menu = menu;
        this._menuManager = new PopupMenu.PopupMenuManager(this._anchor);
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        menu.addAction('Close all windows on all workspaces', () => {
            const currentTime = global.get_current_time();
            for (const w of Display.get_tab_list(Meta.TabList.NORMAL, null)) w.delete(currentTime);
        });

        if (windows.length > 0) {
            menu.addAction(`Close all windows except workspace ${this._workspace.index()}`, () => {
                const currentTime = global.get_current_time();
                for (const w of Display.get_tab_list(Meta.TabList.NORMAL, null).filter(w => w.get_workspace() !== this._workspace))
                    w.delete(currentTime);
            });
            menu.addAction(`Close all windows on workspace ${this._workspace.index()}`, () => {
                const currentTime = global.get_current_time();
                for (const w of windows) w.delete(currentTime);
            });
        }

        menu.open(true);
    }

    close() {
        if (this._menu) { this._menu.close(); this._menu = null; this._menuManager = null; }
    }

    destroy() { this.close(); }
}

// ==================== WORKSPACE THUMBNAIL ====================
export class WorkspaceThumbnail extends St.Button {
    static { GObject.registerClass(this); }

    constructor(workspace, settings) {
        super({ style_class: 'workspace-thumbnail', x_expand: true, y_expand: true });
        this._settings = settings;
        this.set_style(`min-width: ${settings.get_int('thumbnail-min-width')}px;`);

        this._workspace = workspace;
        this._windowsBox = new St.BoxLayout();
        this.set_child(this._windowsBox);

        this._orderStore = new WindowOrderStore(workspace);
        this._displayMode = new ThumbnailDisplayModeController(this._windowsBox, this._orderStore, this._settings, {
            onIconClicked: window => { this._workspace.activate(0); window.activate(0); },
        });
        this._actionMenu = new ThumbnailActionMenu(workspace, this);
        this._nameHintLabel = null;

        WorkspaceThumbnailRegistry.register(this);
        this._delegate = this;

        this._wsChangedId = WorkspaceManager.connect('workspace-switched', () => this._actionMenu.close());

        this.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_PRIMARY) this._workspace.activate(0);
            if (button === Clutter.BUTTON_SECONDARY) this._actionMenu.open();
            return Clutter.EVENT_STOP;
        });
    }

    get workspace() { return this._workspace; }
    get workspaceIndex() { return this._workspace.index(); }

    moveWindowHere(window, insertIndex = null) {
        const wasSameWorkspace = window.get_workspace() === this._workspace;
        const monitorIndex = Main.layoutManager.findIndexForActor(this);
        if (monitorIndex !== window.get_monitor()) window.move_to_monitor(monitorIndex);
        if (insertIndex !== null && !wasSameWorkspace) this._orderStore.setPendingInsertIndex(window, insertIndex);
        window.change_workspace(this._workspace);
        if (insertIndex !== null && wasSameWorkspace) this._orderStore.reorderWindowToIndex(window, insertIndex);
    }

    syncChildOrder() { this._displayMode.syncChildOrder(); }
    cleanupSources() { this._orderStore.cleanupSources(); }

    showNameHint() {
        if (!this._settings.get_boolean('show-workspace-names'))
            return;
        if (!this._nameHint)
            this._nameHint = new FloatingTooltip({ fontSize: this._settings.get_int('tooltip-font-size') });
        this._nameHint.showAbove(this, Meta.prefs_get_workspace_name(this._workspace.index()));
    }

    hideNameHint() {
        this._nameHint?.hide();
    }

    handleDragOver(source, actor, x, y, time) {
        const draggedWindow = getDraggedWindow(source);
        if (!draggedWindow) {
            journal('[WorkspaceThumbnail] handleDragOver: no dragged window');
            return DND.DragMotionResult.CONTINUE;
        }

        WorkspaceThumbnailRegistry.hideAllNameHints();
        this.showNameHint();

        if (this._displayMode.mode !== 'direct') return DND.DragMotionResult.MOVE_DROP;

        const [pointerX] = global.get_pointer();
        const insertion = WindowReorderDragController.computeInsertionFromPointer(draggedWindow, this._orderStore.order, pointerX, this._windowsBox);
        WindowReorderDragController.updatePlaceholder(this._windowsBox, insertion.insertIndex);
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, actor, x, y, time) {
        return WindowReorderDragController.acceptDrop(this, source, actor, time);
    }

    destroy() {
        if (this._wsChangedId) { WorkspaceManager.disconnect(this._wsChangedId); this._wsChangedId = null; }
        this._actionMenu.destroy();
        this._nameHint?.destroy();
        this._nameHint = null;
        WindowReorderDragController.clearIfRelated(this._windowsBox);
        WorkspaceThumbnailRegistry.unregister(this);
        this._orderStore.destroy();
        this._displayMode.destroy();
        super.destroy();
    }
}