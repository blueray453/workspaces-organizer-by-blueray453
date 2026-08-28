import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { TimeoutDelay } from './shellGlobals.js';
import { InsertionPlaceholder } from './insertionPlaceholder.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';
import { WindowIconButton } from './windowIconButton.js'
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
    // The single entry point for "a drag was dropped onto `targetThumbnail`".
    // WorkspaceThumbnail.acceptDrop() and WindowIconButton.acceptDrop()
    // both delegate straight here — neither touches order stores, display
    // mode, or actor transforms themselves. Returns true/false exactly
    // like the dnd.js acceptDrop contract expects.
    acceptDrop(targetThumbnail, source, actor, time) {
        const draggedWindow = getDraggedWindow(source);
        if (!draggedWindow) {
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
            if (actor.get_parent() === Main.uiGroup)
                actor.get_parent().remove_child(actor);
            try { actor.destroy(); } catch (e) { /* already gone */ }
            return;
        }

        targetOrderStore.reorderWindowToIndex(draggedWindow, insertIndex);

        if (actor instanceof WindowIconButton) {
            // Real persistent icon widget — splice it in directly at its
            // new spot, matching the store we just reordered.
            this._prepareDropSettle(actor);
            if (actor.get_parent() === Main.uiGroup)
                actor.get_parent().remove_child(actor);
            targetBox.insert_child_at_index(actor, insertIndex);
            this._playDropSettle(actor);
            // Do NOT call sync() – the child order already matches the store.
        } else {
            // Synthetic drag actor (e.g. from WindowSearchOverlay) — the
            // real WindowIconButton for this window already lives in
            // _windowPreviews untouched. Discard the ghost and just
            // reflow the box to match the reordered store.
            if (actor.get_parent())
                actor.get_parent().remove_child(actor);
            try { actor.destroy(); } catch (e) { /* already gone */ }
            targetDisplay.syncChildOrder();
        }
    },

    _acceptCrossWorkspace(targetThumbnail, draggedWindow, actor, insertIndex) {
        const targetDisplay = targetThumbnail._displayMode;
        const targetOrderStore = targetThumbnail._orderStore;

        const monitorIndex = Main.layoutManager.findIndexForActor(targetThumbnail);
        if (monitorIndex !== draggedWindow.get_monitor())
            draggedWindow.move_to_monitor(monitorIndex);

        // Take custody of the actor FIRST, before any other decision.
        // dnd.js must never find it still parented in Main.uiGroup once
        // acceptDrop() returns true — that's what lets its
        // restoreOnSuccess logic reattach a real WindowIconButton back
        // into a box whose window it no longer represents (ghost icon /
        // "snaps back to old workspace" bug).
        if (actor.get_parent() === Main.uiGroup)
            actor.get_parent().remove_child(actor);

        const sourceThumbnail = WorkspaceThumbnailRegistry.getForWorkspace(draggedWindow.get_workspace());
        journal(`[WindowReorderDragController] acceptCrossWorkspace: sourceThumbnail=${sourceThumbnail ? 'found' : 'null'}`);

        let preview = null;
        if (sourceThumbnail) {
            preview = sourceThumbnail._displayMode.releasePreview(draggedWindow);
            journal(`[WindowReorderDragController] acceptCrossWorkspace: releasePreview=${preview ? 'got actor' : 'null'}`);
        }

        // Changing workspace fires window-removed on the source (letting
        // its order store/display mode rebuild normally and — if this
        // drop takes it back under the threshold — collapse out of
        // collection mode on its own) and window-added on the target
        // (debounced; we short-circuit that below when we have a preview
        // to reuse).
        draggedWindow.change_workspace(targetThumbnail.workspace);

        const prospectiveCount = targetOrderStore.order.length + 1;
        const targetWillStayDirect = targetDisplay.wouldStayDirect(prospectiveCount);
        journal(`[WindowReorderDragController] acceptCrossWorkspace: prospectiveCount=${prospectiveCount} targetWillStayDirect=${targetWillStayDirect}`);

        if (targetWillStayDirect && preview) {
            // Fast path: reuse the actual actor, no destroy/recreate.
            this._resetDragTransform(actor);

            targetOrderStore.insertWindowImmediate(draggedWindow, insertIndex);
            targetDisplay.adoptPreview(draggedWindow, preview, insertIndex);
        } else {
            // Either this drop crosses into collection mode (needs a full
            // teardown to the single overflow button — not something
            // adoptPreview can do), or there was no live preview to reuse
            // (e.g. the drag came from the search overlay, or the source
            // thumbnail couldn't be resolved). Dispose whatever actor
            // we're holding and let sync() rebuild the target from
            // scratch in whichever mode the new count calls for.
            if (preview) {
                try { preview.destroy(); } catch (e) { /* already gone */ }
            } else if (actor) {
                try { actor.destroy(); } catch (e) { /* already gone */ }
            }
            targetOrderStore.insertWindowImmediate(draggedWindow, insertIndex);
            targetDisplay.sync();
        }
    },

    _prepareDropSettle(actor) {
        actor.remove_style_class_name('reorder-drag-source');
        actor.set_translation(0, 0, 0);
        actor.set_position(0, 0);
        actor.set_pivot_point(0.5, 0.5);
        actor.set_scale(0.85, 0.85);
        actor.opacity = 160;
    },

    _playDropSettle(actor) {
        actor.ease({
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: TimeoutDelay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    },

    // Kept for the cross-workspace path, where `actor` isn't guaranteed to
    // already be in its final parent/position when this runs.
    _resetDragTransform(actor) {
        this._prepareDropSettle(actor);
        this._playDropSettle(actor);
    },
};