import { InsertionPlaceholder } from './insertionPlaceholder.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';
import { WindowActorRegistry } from './windowActorRegistry.js';
import { WorkspaceWindowMover } from './workspaceWindowMover.js';
import { getDraggedWindow } from './dragHelpers.js';

import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

// ==================== WINDOW REORDER DRAG CONTROLLER ====================
// Single owner of the ENTIRE "drag a window icon and drop it somewhere"
// flow: visual state (drag-source styling, ghost placeholder), insertion
// index math, and drop acceptance. Model mutation is delegated to
// WorkspaceWindowMover. Canonical WindowIconButton actors are leased through
// WindowActorRegistry for the duration of DND, so normal order-changed
// signals never have to be suppressed. Singleton.
export const WindowReorderDragController = {
    _sourcePreview: null,
    _draggedWindow: null,
    _insertion: new InsertionPlaceholder(),

    beginDrag(sourcePreview, explicitWindow = null) {
        if (this._sourcePreview && this._sourcePreview !== sourcePreview)
            this.endDrag();

        const window = explicitWindow ?? sourcePreview?.window ?? sourcePreview?._window;
        if (!window)
            throw new Error('WindowReorderDragController.beginDrag requires a window');

        this._sourcePreview = sourcePreview;
        this._draggedWindow = window;
        this._insertion.clear();

        // WindowIconButton actors are canonical display actors and must be
        // leased during DND. Synthetic drag actors (e.g. search-overlay rows)
        // are independent and do not participate in actor handoff.
        if (WindowActorRegistry.get(window) === sourcePreview)
            WindowActorRegistry.acquire(window, sourcePreview);

        if (typeof sourcePreview.add_style_class_name === 'function')
            sourcePreview.add_style_class_name('reorder-drag-source');
    },

    endDrag() {
        this._insertion.clear();
        WorkspaceThumbnailRegistry.hideAllNameHints();

        const sourcePreview = this._sourcePreview;
        const window = this._draggedWindow;

        if (sourcePreview) {
            try { sourcePreview.remove_style_class_name('reorder-drag-source'); }
            catch (e) { /* actor may already be destroyed */ }
        }

        if (sourcePreview && window && WindowActorRegistry.isLeased(window, sourcePreview))
            WindowActorRegistry.release(window, sourcePreview);

        this._sourcePreview = null;
        this._draggedWindow = null;
    },

    clearIfRelated(actor) {
        if (this._sourcePreview === actor) {
            this._insertion.clear();
            this._sourcePreview = null;
            this._draggedWindow = null;
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

        // Recompute the insertion position from the target's current state at
        // drop time. This avoids trusting a potentially coalesced drag-motion
        // event immediately before release.
        const insertIndex = targetThumbnail.getDropIndex(draggedWindow);
        this.clearPlaceholder();

        const sameWorkspace = draggedWindow.get_workspace() === targetThumbnail.workspace;
        journal(`[WindowReorderDragController] acceptDrop: sameWorkspace=${sameWorkspace} insertIndex=${insertIndex}`);

        if (WindowActorRegistry.isLeased(draggedWindow, this._sourcePreview)) {
            WindowActorRegistry.setDestination(draggedWindow, targetThumbnail.workspace);
            WindowActorRegistry.setDestinationIndex(draggedWindow, insertIndex);
        }

        WorkspaceWindowMover.move(
            draggedWindow,
            targetThumbnail,
            insertIndex
        );

        return true;
    },

};
