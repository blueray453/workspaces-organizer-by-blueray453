import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { TimeoutDelay } from './shellGlobals.js';
import { InsertionPlaceholder } from './insertionPlaceholder.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';
import { WindowIconButton } from './windowIconButton.js'
import { getDraggedWindow } from './dragHelpers.js';
import { settleIcon } from './animationHelpers.js';

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
    // The single entry point for "a drag was dropped onto `targetThumbnail`".
    // WorkspaceThumbnail.acceptDrop() and WindowIconButton.acceptDrop()
    // both delegate straight here — neither touches order stores, display
    // mode, or actor transforms themselves. Returns true/false exactly
    // like the dnd.js acceptDrop contract expects.
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
            this._acceptCrossWorkspace(targetThumbnail, draggedWindow, actor, insertIndex);
        }

        this.endDrag();
        return true;
    },

    _acceptSameWorkspace(targetThumbnail, draggedWindow, actor, insertIndex) {
        const targetBox = targetThumbnail._windowsBox;
        const targetDisplay = targetThumbnail._displayMode;
        const targetOrderStore = targetThumbnail._orderStore;

        if (targetDisplay.mode !== 'direct') {
            return;
        }

        targetOrderStore.setSuppressSync(true);
        targetOrderStore.reorderWindowToIndex(draggedWindow, insertIndex);
        targetOrderStore.setSuppressSync(false);

        if (actor instanceof WindowIconButton) {
            const actorParent = actor.get_parent();
            if (actorParent)
                actorParent.remove_child(actor);

            // Insert into the box
            targetBox.insert_child_at_index(actor, insertIndex);
            // 👇 Apply settle animation
            settleIcon(actor);
        } else {
            // Synthetic drag actor – discard and reflow
            if (actor.get_parent())
                actor.get_parent().remove_child(actor);
            try { actor.destroy(); } catch (e) { /* ignore */ }
            targetDisplay.syncChildOrder();
            // If we want to animate newly created icons, we'd need a more complex approach.
            // For now, we skip animation in this path.
        }
    },

    _acceptCrossWorkspace(targetThumbnail, draggedWindow, actor, insertIndex) {
        const sourceThumbnail = WorkspaceThumbnailRegistry.getForWorkspace(
            draggedWindow.get_workspace()
        );
        const sourceOrderStore = sourceThumbnail?._orderStore;

        const targetBox = targetThumbnail._windowsBox;
        const targetDisplay = targetThumbnail._displayMode;
        const targetOrderStore = targetThumbnail._orderStore;

        // ---- 1. Insert into target order FIRST (bypass debounce) ----
        targetOrderStore.insertWindowImmediate(draggedWindow, insertIndex);
        journal('[WindowReorderDragController] inserted into target store');

        // ---- 2. Move the window (compositor) ----
        const monitorIndex = Main.layoutManager.findIndexForActor(targetThumbnail);
        if (monitorIndex !== draggedWindow.get_monitor())
            draggedWindow.move_to_monitor(monitorIndex);
        draggedWindow.change_workspace(targetThumbnail.workspace);
        journal('[WindowReorderDragController] workspace changed');

        // ---- 3. Remove source preview ----
        if (sourceThumbnail) {
            const preview = sourceThumbnail._displayMode.releasePreview(draggedWindow);
            if (preview) {
                try { preview.destroy(); } catch (e) { /* ignore */ }
            }
        }

        // ---- 4. Remove drag actor from UI group ----
        if (actor && actor.get_parent() === Main.uiGroup) {
            actor.get_parent().remove_child(actor);
        }

        // ---- 5. Rebuild target UI ----
        const targetWillStayDirect = targetDisplay.wouldStayDirect(targetOrderStore.order.length);
        if (targetWillStayDirect) {
            // Manual insertion
            const newIcon = new WindowIconButton(draggedWindow, targetDisplay._settings);
            const childCount = targetBox.get_children().length;
            const clampedIndex = Math.max(0, Math.min(insertIndex, childCount));
            targetBox.insert_child_at_index(newIcon, clampedIndex);
            targetDisplay._windowPreviews.set(draggedWindow, newIcon);
            settleIcon(newIcon);
        } else {
            // Hard rebuild (switches to collection mode)
            targetDisplay.sync();
        }

        // ---- 6. Rebuild source UI ----
        if (sourceOrderStore) {
            sourceOrderStore.setSuppressSync(false);
            sourceOrderStore._emitOrderChanged();
        }

        // ---- 7. Cleanup ----
        this.endDrag();
    },
};