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
            // ... (no change)
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
        const targetDisplay = targetThumbnail._displayMode;
        const targetOrderStore = targetThumbnail._orderStore;
        const targetBox = targetThumbnail._windowsBox;

        let sourceThumbnail = null;
        let sourceOrderStore = null;
        let preview = null;

        try {
            journal('[WindowReorderDragController] _acceptCrossWorkspace start');

            // ---- 1. Suppress sync on TARGET ----
            targetOrderStore.setSuppressSync(true);
            journal('[WindowReorderDragController] target sync suppressed');

            // ---- 2. Find source thumbnail and suppress its sync too ----
            sourceThumbnail = WorkspaceThumbnailRegistry.getForWorkspace(draggedWindow.get_workspace());
            journal(`[WindowReorderDragController] acceptCrossWorkspace: sourceThumbnail=${!!sourceThumbnail}`);
            if (sourceThumbnail) {
                sourceOrderStore = sourceThumbnail._orderStore;
                sourceOrderStore.setSuppressSync(true);
                journal('[WindowReorderDragController] source sync suppressed');
            }

            // ---- 3. Move window to target monitor (if needed) ----
            const monitorIndex = Main.layoutManager.findIndexForActor(targetThumbnail);
            if (monitorIndex !== draggedWindow.get_monitor()) {
                journal(`[WindowReorderDragController] moving window to monitor ${monitorIndex}`);
                draggedWindow.move_to_monitor(monitorIndex);
            }

            // ---- 4. Remove drag actor from UI group ----
            if (actor && actor.get_parent() === Main.uiGroup) {
                actor.get_parent().remove_child(actor);
                journal('[WindowReorderDragController] removed actor from uiGroup');
            }

            // ---- 5. Release preview from source (while source sync is suppressed) ----
            if (sourceThumbnail) {
                preview = sourceThumbnail._displayMode.releasePreview(draggedWindow);
                journal(`[WindowReorderDragController] releasePreview returned ${!!preview}`);
                if (preview) {
                    journal(`[WindowReorderDragController] preview parent before change: ${preview.get_parent()}`);
                }
            } else {
                journal('[WindowReorderDragController] no source thumbnail to release preview from');
            }

            // ---- 6. Change workspace (source sync is still suppressed) ----
            journal('[WindowReorderDragController] about to change workspace');
            if (preview) {
                try {
                    const stage = preview.get_stage();
                    journal(`[WindowReorderDragController] preview stage before change: ${stage}`);
                } catch (e) {
                    journal(`[WindowReorderDragController] preview stage check threw: ${e}`);
                }
            }
            draggedWindow.change_workspace(targetThumbnail.workspace);
            journal('[WindowReorderDragController] workspace changed');

            // ---- 7. Check preview validity after workspace change ----
            if (preview) {
                try {
                    const stage = preview.get_stage();
                    if (stage === null) {
                        journal('[WindowReorderDragController] preview stage is null – assuming destroyed, will create new icon');
                        preview = null;
                    } else {
                        journal(`[WindowReorderDragController] preview stage after change: ${stage}`);
                    }
                } catch (e) {
                    journal(`[WindowReorderDragController] preview invalid after change: ${e}`);
                    preview = null;
                }
            }

            // ---- 8. Update target order store ----
            targetOrderStore.insertWindowImmediate(draggedWindow, insertIndex);
            journal(`[WindowReorderDragController] inserted into target store at index ${insertIndex}`);

            const prospectiveCount = targetOrderStore.order.length;
            const targetWillStayDirect = targetDisplay.wouldStayDirect(prospectiveCount);
            journal(`[WindowReorderDragController] targetWillStayDirect=${targetWillStayDirect}`);

            // ---- 9. Place actor in target ----
            if (targetWillStayDirect) {
                if (preview) {
                    journal('[WindowReorderDragController] calling adoptPreview with valid preview');
                    targetDisplay.adoptPreview(draggedWindow, preview, insertIndex);
                    journal('[WindowReorderDragController] adoptPreview done');
                    settleIcon(preview);
                    journal('[WindowReorderDragController] settleIcon done on preview');
                } else {
                    // Preview destroyed – create new icon
                    journal('[WindowReorderDragController] preview invalid – creating new icon');
                    const newIcon = new WindowIconButton(draggedWindow, targetDisplay._settings);
                    const childCount = targetBox.get_children().length;
                    const clampedIndex = Math.max(0, Math.min(insertIndex, childCount));
                    targetBox.insert_child_at_index(newIcon, clampedIndex);
                    targetDisplay._windowPreviews.set(draggedWindow, newIcon);
                    settleIcon(newIcon);
                    journal('[WindowReorderDragController] settleIcon done on new icon');
                }
            } else {
                // Collection mode – destroy leftovers and rebuild
                journal('[WindowReorderDragController] target switches to collection mode');
                if (preview) {
                    try { preview.destroy(); } catch (e) { /* ignore */ }
                } else {
                    try { actor.destroy(); } catch (e) { /* ignore */ }
                }
            }

            // ---- 10. Re‑enable sync on source and target ----
            journal('[WindowReorderDragController] re‑enabling target sync');
            targetOrderStore.setSuppressSync(false);

            if (sourceOrderStore) {
                journal('[WindowReorderDragController] re‑enabling source sync');
                sourceOrderStore.setSuppressSync(false);
                // Force source to rebuild (it lost a window)
                sourceOrderStore._emitOrderChanged();
                journal('[WindowReorderDragController] source sync triggered');
            }

            // Only call sync() on target if we went into collection mode
            if (!targetWillStayDirect) {
                journal('[WindowReorderDragController] calling targetDisplay.sync() for collection mode');
                targetDisplay.sync();
            }

            journal('[WindowReorderDragController] _acceptCrossWorkspace complete');

        } catch (e) {
            journal(`[WindowReorderDragController] _acceptCrossWorkspace error: ${e}`);
            journal(`    stack: ${e.stack}`);
            // Clean up
            if (preview) {
                try { preview.destroy(); } catch (e2) { }
            }
            if (sourceOrderStore) {
                try { sourceOrderStore.setSuppressSync(false); } catch (e2) { }
            }
            try { targetOrderStore.setSuppressSync(false); } catch (e2) { }
            throw e;
        }
    },
};