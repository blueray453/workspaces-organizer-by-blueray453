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
import { WindowActorRegistry } from './windowActorRegistry.js';
import { WindowReorderDragController } from './windowReorderDragController.js';
import { getDraggedWindow } from './dragHelpers.js';
import { WindowIconButton } from './windowIconButton.js';
import { WindowSearchOverlay } from './windowSearchOverlay.js';

import { FloatingTooltip } from './floatingTooltip.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== WINDOW ORDER STORE ====================
// Bookkeeping for one workspace's window list and user-defined order.
// It deliberately knows nothing about actors, dragging, or rendering.
class WindowOrderStore {
    constructor(workspace) {
        this._workspace = workspace;
        this._order = [];
        this._pendingInsertIndices = new Map();
        this._addWindowTimeoutIds = new Map();
        this._onOrderChanged = null;

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
                const clamped = Math.max(0, Math.min(insertIndex, this._order.length));
                this._order.splice(clamped, 0, window);
                this._emitOrderChanged('reorder-add');
            }
            return;
        }

        this._order.splice(currentIndex, 1);
        const clamped = Math.max(0, Math.min(insertIndex, this._order.length));
        this._order.splice(clamped, 0, window);
        this._emitOrderChanged('reorder');
    }

    // Explicit workspace moves use this intent before change_workspace().
    // The actual model update still happens through the normal window-added signal.
    setPendingInsertIndex(window, index) {
        this._pendingInsertIndices.set(window, index);
    }

    cleanupSources() {
        for (const [, id] of this._addWindowTimeoutIds)
            GLib.Source.remove(id);
        this._addWindowTimeoutIds.clear();
    }

    destroy() {
        this.cleanupSources();
        this._pendingInsertIndices.clear();
        if (this._windowAddedId) this._workspace.disconnect(this._windowAddedId);
        if (this._windowRemovedId) this._workspace.disconnect(this._windowRemovedId);
        if (this._windowCreatedId) Display.disconnect(this._windowCreatedId);
        this._onOrderChanged = null;
    }

    _addWindow(window) {
        if (window.skip_taskbar) return;

        if (this._order.includes(window)) {
            this._pendingInsertIndices.delete(window);
            return;
        }

        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }

        // Keep the existing geometry-settling debounce for ordinary newly
        // created windows. Explicit drag moves consume their placement intent
        // immediately once Mutter reports the new workspace membership.
        if (this._pendingInsertIndices.has(window)) {
            const index = this._pendingInsertIndices.get(window);
            this._pendingInsertIndices.delete(window);
            if (window.get_workspace() === this._workspace) {
                const clamped = Math.max(0, Math.min(index, this._order.length));
                this._order.splice(clamped, 0, window);
                this._emitOrderChanged('explicit-move');
            }
            return;
        }

        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
            this._addWindowTimeoutIds.delete(window);
            if (window.get_workspace() !== this._workspace)
                return GLib.SOURCE_REMOVE;

            if (!this._order.includes(window)) {
                this._order.push(window);
                this._emitOrderChanged('window-added');
            }
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
        this._emitOrderChanged('window-removed');
    }

    _emitOrderChanged(reason) {
        this._onOrderChanged?.({
            workspace: this._workspace,
            order: this._order.slice(),
            reason,
        });
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
// Reconciles the actor tree from WindowOrderStore. Actor lifetime is governed
// by WindowActorRegistry so an actor owned by an active drag is never destroyed
// merely because Mutter has temporarily removed the window from this workspace.
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
        this._orderStore.setOnOrderChanged(() => this._reconcile());
        this._leaseRelease = WindowActorRegistry.onReleased((window, actor, handoff) => {
            if (!actor)
                return;

            const destinationWorkspace = handoff?.destination ?? null;
            const isDestination = destinationWorkspace === this._orderStore.workspace;
            const isCurrentWorkspace = window.get_workspace?.() === this._orderStore.workspace;
            const ownsWindow = this._orderStore.order.includes(window);

            if (!isDestination && !isCurrentWorkspace && !ownsWindow)
                return;

            this._reconcile();

            // On a successful move the destination display is the owner. On a
            // failed/cancelled move the original display becomes the owner.
            // The handoff state prevents either side from destroying the actor
            // before one of them claims it.
            if ((isDestination || isCurrentWorkspace) && ownsWindow)
                this._claimReleasedActor(window, actor, handoff?.index);
        });

        this._reconcile();
    }

    get mode() { return this._mode; }

    _windowsInWorkspace() {
        return this._orderStore.order.filter(window => {
            try {
                return window.get_workspace() === this._orderStore.workspace;
            } catch (e) {
                return false;
            }
        });
    }

    _reconcile() {
        const windows = this._windowsInWorkspace();

        if (windows.length > DIRECT_MODE_MAX_WINDOWS)
            this._reconcileCollectionMode(windows);
        else
            this._reconcileDirectMode(windows);
    }

    destroy() {
        if (this._settingsChangeId) {
            this._settings.disconnect(this._settingsChangeId);
            this._settingsChangeId = null;
        }
        if (this._leaseRelease) {
            this._leaseRelease();
            this._leaseRelease = null;
        }

        for (const [window, preview] of this._windowPreviews) {
            if (preview.get_parent() === this._box)
                this._box.remove_child(preview);
            WindowActorRegistry.unregister(window, preview);
            if (!WindowActorRegistry.isLeased(window, preview)) {
                try { preview.destroy(); } catch (e) { }
            }
        }
        this._windowPreviews.clear();

        if (this._collectionIcon) {
            if (this._collectionIcon.get_parent() === this._box)
                this._box.remove_child(this._collectionIcon);
            this._collectionIcon.destroy();
            this._collectionIcon = null;
        }
    }

    _createPreview(window) {
        if (!this._box || !this._box.get_stage())
            return null;

        const preview = new WindowIconButton(window, this._settings);
        preview.connect('clicked', () => this._onIconClicked(window));
        WindowActorRegistry.register(window, preview);
        return preview;
    }

    _destroyPreview(window, preview) {
        this._windowPreviews.delete(window);

        // DND lease/handoff owns the actor. Detach it from this box if needed,
        // but never destroy it. The destination/current display will claim it.
        if (WindowActorRegistry.isProtected(window, preview)) {
            if (preview.get_parent() === this._box)
                this._box.remove_child(preview);
            return;
        }

        // Another display may already own this canonical actor. In that case
        // this display is only discarding a stale local map entry.
        if (WindowActorRegistry.get(window) !== preview || preview.get_parent() !== this._box)
            return;

        WindowActorRegistry.unregister(window, preview);

        try {
            preview.destroy();
        } catch (e) {
            // Shell shutdown / actor already destroyed.
        }
    }

    _reconcileCollectionMode(windows) {
        for (const [window, preview] of [...this._windowPreviews])
            this._destroyPreview(window, preview);

        // If a dragged actor landed in collection mode, there is no direct
        // button to adopt it into. Claim the handoff and let the registry
        // destroy that now-unneeded direct-mode actor safely.
        for (const window of windows) {
            const actor = WindowActorRegistry.get(window);
            if (actor && WindowActorRegistry.isProtected(window, actor))
                WindowActorRegistry.claim(window, actor);
            if (actor && this._orderStore.order.includes(window))
                WindowActorRegistry.destroyWindow(window);
        }

        if (!this._collectionIcon) {
            this._collectionIcon = new WindowOverflowButton(
                () => this._windowsInWorkspace().slice(),
                this._settings
            );
            this._box.add_child(this._collectionIcon);
        }

        this._collectionIcon.setCount(windows.length);
        this._mode = 'collection';
    }

    _reconcileDirectMode(windows) {
        if (this._collectionIcon) {
            if (this._collectionIcon.get_parent() === this._box)
                this._box.remove_child(this._collectionIcon);
            this._collectionIcon.destroy();
            this._collectionIcon = null;
        }

        const desired = new Set(windows);

        for (const [window, preview] of [...this._windowPreviews]) {
            if (!desired.has(window))
                this._destroyPreview(window, preview);
        }

        for (const window of windows) {
            const actor = WindowActorRegistry.get(window);

            if (WindowActorRegistry.isLeased(window))
                continue;

            if (WindowActorRegistry.isProtected(window)) {
                // A post-DND handoff belongs here. Claim it only when this
                // display is actually the window's current workspace.
                if (actor && window.get_workspace() === this._orderStore.workspace)
                    this._claimReleasedActor(
                        window,
                        actor,
                        WindowActorRegistry.getDestination(window)?.index ?? null
                    );
                continue;
            }

            if (this._windowPreviews.has(window))
                continue;

            if (actor) {
                this._windowPreviews.set(window, actor);
                continue;
            }

            const preview = this._createPreview(window);
            if (preview)
                this._windowPreviews.set(window, preview);
        }

        this._placeInOrder(windows);
        this._mode = 'direct';
        this._updateAllIconSizes();
    }

    _placeInOrder(windows) {
        const orderedPreviews = [];
        for (const window of windows) {
            const preview = this._windowPreviews.get(window);
            if (!preview || WindowActorRegistry.isLeased(window, preview))
                continue;

            if (preview.get_parent() === this._box)
                this._box.remove_child(preview);

            orderedPreviews.push(preview);
        }

        for (const preview of orderedPreviews)
            this._box.add_child(preview);
    }

    _claimReleasedActor(window, actor, requestedIndex = null) {
        try {
            if (window.get_workspace() !== this._orderStore.workspace)
                return false;
        } catch (e) {
            return false;
        }

        if (!this._orderStore.order.includes(window))
            return false;

        const handoff = WindowActorRegistry.getDestination(window);
        const protectedActor = WindowActorRegistry.isProtected(window, actor);

        if (protectedActor && !WindowActorRegistry.claim(window, actor))
            return false;

        if (this._mode === 'collection') {
            this._windowPreviews.delete(window);
            WindowActorRegistry.destroyWindow(window);
            return true;
        }

        this._windowPreviews.set(window, actor);

        try {
            const parent = actor.get_parent();
            if (parent && parent !== this._box)
                parent.remove_child(actor);

            if (actor.get_parent() !== this._box)
                this._box.add_child(actor);
        } catch (e) {
            journal(`[ThumbnailDisplayModeController] failed to attach released actor: ${e}`);
            return false;
        }

        const windows = this._windowsInWorkspace();
        const preferredIndex = requestedIndex ?? handoff?.index ?? null;
        const orderIndex = preferredIndex === null
            ? windows.indexOf(window)
            : Math.max(0, Math.min(preferredIndex, windows.length - 1));

        if (actor.get_parent() === this._box)
            this._box.remove_child(actor);
        this._box.insert_child_at_index(actor, Math.max(0, orderIndex));
        actor.setIconSize(this._settings.get_int('icon-size'));
        return true;
    }

    _updateAllIconSizes() {
        const iconSize = this._settings.get_int('icon-size');
        for (const preview of this._windowPreviews.values())
            preview.setIconSize(iconSize);
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

    getDropIndex(draggedWindow) {
        if (this._displayMode.mode !== 'direct')
            return this._orderStore.order.length;

        const [pointerX] = global.get_pointer();
        return WindowReorderDragController.computeInsertionFromPointer(
            draggedWindow,
            this._orderStore.order,
            pointerX,
            this._windowsBox
        ).insertIndex;
    }

    moveWindowHere(window, insertIndex = null) {
        const wasSameWorkspace = window.get_workspace() === this._workspace;
        const monitorIndex = Main.layoutManager.findIndexForActor(this);
        if (monitorIndex !== window.get_monitor())
            window.move_to_monitor(monitorIndex);

        if (insertIndex !== null && !wasSameWorkspace)
            this._orderStore.setPendingInsertIndex(window, insertIndex);

        window.change_workspace(this._workspace);

        if (insertIndex !== null && wasSameWorkspace)
            this._orderStore.reorderWindowToIndex(window, insertIndex);
    }
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

    handleWindowDragOver(draggedWindow, targetPreview, x, y, time) {
        if (!draggedWindow || targetPreview?.window === draggedWindow) return DND.DragMotionResult.MOVE_DROP;
        return this.handleDragOver({ _window: draggedWindow }, null, x, y, time);
    }

    acceptWindowDrop(draggedWindow, targetPreview, x, y, time) {
        if (!draggedWindow) return false;
        return this.acceptDrop({ _window: draggedWindow }, null, x, y, time);
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
