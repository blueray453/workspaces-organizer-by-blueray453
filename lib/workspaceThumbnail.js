import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';
import { WindowIconButton } from './windowIconButton.js';
import { WindowSearchOverlay } from './windowSearchOverlay.js';
import { InsertionPlaceholder } from './insertionPlaceholder.js';
import { DragSession } from './dragSession.js';

import { WorkspaceManager, Display, TimeoutDelay, DIRECT_MODE_MAX_WINDOWS } from './shellGlobals.js';

import { DragMotionResult, getDraggedWindow } from './dragHelpers.js';
import { createContextMenu } from './menuHelpers.js';
import { FloatingTooltip } from './floatingTooltip.js';
import { settleIcon } from './animationHelpers.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== WINDOW ORDER STORE ====================
// Pure bookkeeping for one workspace's window list and its user-defined
// display order. WorkspaceThumbnail.performCrossWorkspaceDrop is the only
// external caller of _setSuppressSync()/_insertWindowImmediate() — those
// exist to let it perform an atomic cross-thumbnail transplant without a
// double rebuild.
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

    // ---- PRIVATE (but accessible to WorkspaceThumbnail.performCrossWorkspaceDrop) ----
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
        const { menu, menuManager } = createContextMenu(this._anchor);
        this._menu = menu;
        this._menuManager = menuManager;

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

        // Ghost placeholder for THIS thumbnail — owned here, drawn inside
        // _windowsBox, cleared here. No cross-thumbnail state.
        this._insertion = new InsertionPlaceholder();

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

    // Hide the ghost placeholder this thumbnail may be showing. Called by
    // WorkspaceThumbnailRegistry.hideAllGhosts()/hideAllGhostsExcept() on
    // drag-end and on cross-thumbnail hover, and by destroy().
    hideGhost() {
        this._insertion.clear();
    }

    // ==================== DnD CLASSIFICATION ====================
    // This thumbnail is the sole classifier of drag sources. Both
    // handleDragOver and acceptDrop branch on getDraggedWindow() first;
    // everything downstream (this class's own methods, the transplant
    // function, etc.) inherits that decision.
    //
    //   - draggedWindow != null → internal window-icon reorder
    //   - draggedWindow == null → external drag (text, files, images)
    // ============================================================

    handleDragOver(source, actor, x, y, time) {
        const draggedWindow = getDraggedWindow(source);

        WorkspaceThumbnailRegistry.hideAllNameHints();
        this.showNameHint();

        // ---- External drag (text, files, images) ----
        // The Shell DnD system calls us here for these too. We don't own
        // the payload — we only switch workspace on hover so the user can
        // then drop onto a window that lives here.
        if (!draggedWindow) {
            // Ghosts belong only to the hovered thumbnail. Clear everywhere.
            WorkspaceThumbnailRegistry.hideAllGhosts();

            const currentWs = WorkspaceManager.get_active_workspace();
            if (this._workspace !== currentWs) {
                journal(`[WorkspaceThumbnail] External drag → workspace ${this._workspace.index()}`);
                this._workspace.activate(global.get_current_time());
            }
            return DragMotionResult.MOVE_DROP;
        }

        // ---- Internal window-icon reorder ----
        if (this._displayMode.mode !== 'direct') {
            // Not a valid drop target for a reorder — clear every ghost
            // so the user sees nothing stale while hovering here.
            WorkspaceThumbnailRegistry.hideAllGhosts();
            return DragMotionResult.MOVE_DROP;
        }

        // The ghost lives only where the cursor is. Clear every other
        // thumbnail's ghost, then show ours.
        WorkspaceThumbnailRegistry.hideAllGhostsExcept(this);

        const [pointerX] = global.get_pointer();
        const insertIndex = this._computeInsertion(draggedWindow, pointerX);
        this._insertion.show(this._windowsBox, insertIndex, DragSession.ghostTemplate, 96);
        return DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, actor, x, y, time) {
        const draggedWindow = getDraggedWindow(source);

        // ---- External drag (text, files, images) ----
        // Workspace already switched on hover in handleDragOver. Accept
        // so the DnD system doesn't look for another target.
        if (!draggedWindow) {
            WorkspaceThumbnailRegistry.hideAllGhosts();
            return true;
        }

        // ---- Internal window-icon reorder ----
        try {
            const ws = draggedWindow.get_workspace();
            journal(`[WorkspaceThumbnail] acceptDrop: window="${draggedWindow.title}" workspace=${ws?.index()} monitor=${draggedWindow.get_monitor()}`);
        } catch (e) {
            journal(`[WorkspaceThumbnail] acceptDrop: error inspecting window: ${e}`);
            WorkspaceThumbnailRegistry.hideAllGhosts();
            return false;
        }

        // Compute insert index fresh from the current pointer position
        // rather than trusting the last handleDragOver — a coalesced
        // motion event right before release can leave the cached index
        // stale.
        let insertIndex;
        if (this._displayMode.mode === 'direct') {
            const [pointerX] = global.get_pointer();
            insertIndex = this._computeInsertion(draggedWindow, pointerX);
        } else {
            insertIndex = this._orderStore.order.length;
        }

        WorkspaceThumbnailRegistry.hideAllGhosts();

        const sameWorkspace = draggedWindow.get_workspace() === this._workspace;
        journal(`[WorkspaceThumbnail] acceptDrop: sameWorkspace=${sameWorkspace} targetMode=${this._displayMode.mode} insertIndex=${insertIndex}`);

        if (sameWorkspace) {
            this._acceptSameWorkspace(draggedWindow, actor, insertIndex);
        } else {
            // Resolve source thumbnail BEFORE the window's workspace is
            // mutated inside performCrossWorkspaceDrop.
            const sourceThumbnail = WorkspaceThumbnailRegistry.getForWorkspace(draggedWindow.get_workspace());

            if (actor && actor.get_parent() === Main.uiGroup)
                actor.get_parent().remove_child(actor);

            this.performCrossWorkspaceDrop(sourceThumbnail, draggedWindow, insertIndex);
        }

        return true;
    }

    // ==================== INTERNAL HELPERS ====================

    _computeInsertion(draggedWindow, pointerX) {
        const result = this._insertion.computeInsertion(
            this._windowsBox,
            this._orderStore.order,
            draggedWindow,
            w => this._windowsBox.get_children().find(c => c._window === w),
            pointerX);
        return result.index;
    }

    _acceptSameWorkspace(draggedWindow, actor, insertIndex) {
        const targetDisplay = this._displayMode;
        const targetOrderStore = this._orderStore;

        if (targetDisplay.mode !== 'direct')
            return;

        targetOrderStore._setSuppressSync(true);
        targetOrderStore.reorderWindowToIndex(draggedWindow, insertIndex);
        targetOrderStore._setSuppressSync(false);

        if (actor instanceof WindowIconButton) {
            const actorParent = actor.get_parent();
            if (actorParent)
                actorParent.remove_child(actor);
            this._windowsBox.insert_child_at_index(actor, insertIndex);
            settleIcon(actor);
        } else {
            // Synthetic drag actor – discard and reflow
            if (actor.get_parent())
                actor.get_parent().remove_child(actor);
            try { actor.destroy(); } catch (e) { /* ignore */ }
            targetDisplay.syncChildOrder();
        }
    }

    // ==================== CROSS-WORKSPACE TRANSPLANT ====================
    // Moves `window` from `sourceThumbnail`'s workspace to THIS thumbnail's
    // workspace, inserting it at `insertIndex` in our order, and rebuilds
    // both thumbnails.
    //
    // A method on the target (rather than a free function) because "the
    // target receives the window" is the operation's natural voice: the
    // target decides where the new icon goes and rebuilds itself. The
    // source is only mutated as a side effect of being vacated.
    // ====================================================================
    performCrossWorkspaceDrop(sourceThumbnail, window, insertIndex) {
        const targetThumbnail = this;

        const sourceOrderStore = sourceThumbnail?._orderStore;
        const targetOrderStore = targetThumbnail._orderStore;
        const targetDisplay = targetThumbnail._displayMode;
        const targetBox = targetThumbnail._windowsBox;

        // Freeze the source's automatic rebuild while we mutate both stores.
        if (sourceOrderStore)
            sourceOrderStore._setSuppressSync(true);

        // Insert into the target's order FIRST, bypassing the 200 ms settle
        // debounce in WindowOrderStore._addWindow. The window is already
        // mapped and has valid geometry, so there's nothing to wait for; the
        // workspace's own window-added handler will then see the window
        // already present and no-op.
        targetOrderStore._insertWindowImmediate(window, insertIndex);

        // Move the actual window to the target workspace/monitor.
        const monitorIndex = Main.layoutManager.findIndexForActor(targetThumbnail);
        if (monitorIndex !== window.get_monitor())
            window.move_to_monitor(monitorIndex);
        window.change_workspace(targetThumbnail.workspace);

        // Remove the source's icon for this window (if it was showing one).
        if (sourceThumbnail) {
            const preview = sourceThumbnail._displayMode.releasePreview(window);
            if (preview) {
                try { preview.destroy(); } catch (e) { /* ignore */ }
            }
        }

        // Rebuild the target's UI. Two paths:
        //   - still under the direct-mode threshold → add the new icon by hand
        //     so we can animate it in with settleIcon
        //   - crossing into collection mode → let _sync() do the rebuild into
        //     the "N windows" overflow button
        if (targetDisplay.wouldStayDirect(targetOrderStore.order.length)) {
            const newIcon = new WindowIconButton(window, targetDisplay._settings);
            const childCount = targetBox.get_children().length;
            const clampedIndex = Math.max(0, Math.min(insertIndex, childCount));
            targetBox.insert_child_at_index(newIcon, clampedIndex);
            targetDisplay._windowPreviews.set(window, newIcon);
            settleIcon(newIcon);
        } else {
            targetDisplay._sync();
        }

        // Unfreeze the source and rebuild it once.
        if (sourceOrderStore) {
            sourceOrderStore._setSuppressSync(false);
            sourceOrderStore._emitOrderChanged();
        }
    }

    destroy() {
        if (this._wsChangedId) { WorkspaceManager.disconnect(this._wsChangedId); this._wsChangedId = null; }
        this._actionMenu.destroy();
        this._nameHint?.destroy();
        this._nameHint = null;
        this._insertion.clear();
        WorkspaceThumbnailRegistry.unregister(this);
        this._orderStore.destroy();
        this._displayMode.destroy();
        super.destroy();
    }
}