import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { InsertionPlaceholder } from './insertionPlaceholder.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';
import { WindowIconButton } from './windowIconButton.js';

import { settleIcon } from './animationHelpers.js';
import { getDraggedWindow } from './dragHelpers.js';

import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

// ==================== WINDOW REORDER DRAG CONTROLLER ====================
// Single owner of the ENTIRE "drag a window icon and drop it somewhere"
// flow: visual state (drag-source styling, ghost placeholder), insertion
// index math, AND — via acceptDrop() below — the actual drop-acceptance
// decision: same-workspace reorder, cross-workspace transplant, and the
// direct/collection mode-transition check. WorkspaceThumbnail and
// WindowIconButton never touch order stores, display-mode controllers, or
// actor transforms directly during a drop; they resolve a target and
// delegate to acceptDrop() here. Singleton.
export const WindowReorderDragController = {
    _sourcePreview: null,
    _insertion: new InsertionPlaceholder(),

    beginDrag(sourcePreview) {
        if (this._sourcePreview && this._sourcePreview !== sourcePreview)
            this.endDrag();
        this._sourcePreview = sourcePreview;
        this._insertion.clear();
        if (typeof sourcePreview.add_style_class_name === 'function')
            sourcePreview.add_style_class_name('reorder-drag-source');
    },

    endDrag() {
        this._insertion.clear();
        WorkspaceThumbnailRegistry.hideAllNameHints();
        if (this._sourcePreview) {
            try { this._sourcePreview.remove_style_class_name('reorder-drag-source'); }
            catch (e) { /* actor may already be destroyed */ }
        }
        this._sourcePreview = null;
    },

    clearIfRelated(actor) {
        if (this._sourcePreview === actor) {
            this._insertion.clear();
            this._sourcePreview = null;
            return;
        }
        if (this._insertion.getBox() === actor)
            this._insertion.clear();
    },

    computeInsertionFromPointer(draggedWindow, order, pointerX, box) {
        const result = this._insertion.computeInsertion(
            box, order, draggedWindow,
            w => box.get_children().find(c => c._window === w),
            pointerX);
        return { insertIndex: result.index };
    },

    updatePlaceholder(box, index) {
        this._insertion.show(box, index, this._sourcePreview, 96);
    },

    clearPlaceholder() { this._insertion.clear(); },

    getLastInsertion() {
        const index = this._insertion.getLastIndex();
        return index === null ? null : { box: this._insertion.getBox(), index };
    },

    // ==================== DROP ACCEPTANCE ====================
    acceptDrop(targetThumbnail, source, actor, time) {
        const draggedWindow = getDraggedWindow(source);
        if (!draggedWindow) {
            journal('[WindowReorderDragController] acceptDrop: no dragged window');
            this.clearPlaceholder();
            return false;
        }

        try {
            const ws = draggedWindow.get_workspace();
            journal(`[WindowReorderDragController] acceptDrop: window="${draggedWindow.title}" workspace=${ws?.index()} monitor=${draggedWindow.get_monitor()}`);
        } catch (e) {
            journal(`[WindowReorderDragController] acceptDrop: error inspecting window: ${e}`);
            this.clearPlaceholder();
            return false;
        }

        const targetBox = targetThumbnail._windowsBox;
        const targetDisplay = targetThumbnail._displayMode;
        const targetOrderStore = targetThumbnail._orderStore;

        // Collection mode shows a single overflow button, not per-window
        // icons — there's no pointer-derived placeholder position to read
        // back, so append to the end instead of requiring one.
        let insertIndex;
        if (targetDisplay.mode === 'direct') {
            // Recompute fresh from the current pointer position rather than
            // trusting the last recorded handleDragOver — a coalesced/skipped
            // motion event right before release can leave the cached
            // insertion pointing at a stale box/index and wrongly reject
            // the drop.
            const [pointerX] = global.get_pointer();
            const order = targetOrderStore.order;
            const result = this.computeInsertionFromPointer(draggedWindow, order, pointerX, targetBox);
            insertIndex = result.insertIndex;
        } else {
            insertIndex = targetOrderStore.order.length;
        }

        this.clearPlaceholder();

        const sameWorkspace = draggedWindow.get_workspace() === targetThumbnail.workspace;
        journal(`[WindowReorderDragController] acceptDrop: sameWorkspace=${sameWorkspace} targetMode=${targetDisplay.mode} insertIndex=${insertIndex}`);

        if (sameWorkspace) {
            this._acceptSameWorkspace(targetThumbnail, draggedWindow, actor, insertIndex);
        } else {
            // Remove the drag actor from the UI group (if it's there)
            if (actor && actor.get_parent() === Main.uiGroup) {
                actor.get_parent().remove_child(actor);
            }
            // Delegate to the public transaction method
            this.performCrossWorkspaceDrop(targetThumbnail, draggedWindow, insertIndex);
        }

        this.endDrag();
        return true;
    },

    // ---- Public transaction method ----
    performCrossWorkspaceDrop(targetThumbnail, draggedWindow, insertIndex) {
        // ---- 1. Resolve source ----
        const sourceThumbnail = WorkspaceThumbnailRegistry.getForWorkspace(
            draggedWindow.get_workspace()
        );
        const sourceOrderStore = sourceThumbnail?._orderStore;
        const targetOrderStore = targetThumbnail._orderStore;
        const targetDisplay = targetThumbnail._displayMode;
        const targetBox = targetThumbnail._windowsBox;

        // ---- 2. Freeze source (private) ----
        if (sourceOrderStore) {
            sourceOrderStore._setSuppressSync(true);
        }

        // ---- 3. Insert into target order FIRST (bypass debounce) ----
        targetOrderStore._insertWindowImmediate(draggedWindow, insertIndex);

        // ---- 4. Move the window (compositor) ----
        const monitorIndex = Main.layoutManager.findIndexForActor(targetThumbnail);
        if (monitorIndex !== draggedWindow.get_monitor()) {
            draggedWindow.move_to_monitor(monitorIndex);
        }
        draggedWindow.change_workspace(targetThumbnail.workspace);

        // ---- 5. Remove source preview ----
        if (sourceThumbnail) {
            const preview = sourceThumbnail._displayMode.releasePreview(draggedWindow);
            if (preview) {
                try { preview.destroy(); } catch (e) { /* ignore */ }
            }
        }

        // ---- 6. Rebuild target UI (using private _sync if needed) ----
        const targetWillStayDirect = targetDisplay.wouldStayDirect(
            targetOrderStore.order.length
        );
        if (targetWillStayDirect) {
            // Manual insertion with animation
            const newIcon = new WindowIconButton(draggedWindow, targetDisplay._settings);
            const childCount = targetBox.get_children().length;
            const clampedIndex = Math.max(0, Math.min(insertIndex, childCount));
            targetBox.insert_child_at_index(newIcon, clampedIndex);
            targetDisplay._windowPreviews.set(draggedWindow, newIcon);
            settleIcon(newIcon);
        } else {
            // Switch to collection mode – private rebuild
            targetDisplay._sync();
        }

        // ---- 7. Unfreeze and rebuild source ----
        if (sourceOrderStore) {
            sourceOrderStore._setSuppressSync(false);
            sourceOrderStore._emitOrderChanged();
        }
    },

    // ---- Internal helpers ----
    _acceptSameWorkspace(targetThumbnail, draggedWindow, actor, insertIndex) {
        const targetBox = targetThumbnail._windowsBox;
        const targetDisplay = targetThumbnail._displayMode;
        const targetOrderStore = targetThumbnail._orderStore;

        if (targetDisplay.mode !== 'direct') {
            return;
        }

        targetOrderStore._setSuppressSync(true);
        targetOrderStore.reorderWindowToIndex(draggedWindow, insertIndex);
        targetOrderStore._setSuppressSync(false);

        if (actor instanceof WindowIconButton) {
            const actorParent = actor.get_parent();
            if (actorParent)
                actorParent.remove_child(actor);

            // Insert into the box
            targetBox.insert_child_at_index(actor, insertIndex);
            settleIcon(actor);
        } else {
            // Synthetic drag actor – discard and reflow
            if (actor.get_parent())
                actor.get_parent().remove_child(actor);
            try { actor.destroy(); } catch (e) { /* ignore */ }
            targetDisplay.syncChildOrder();
        }
    },
};