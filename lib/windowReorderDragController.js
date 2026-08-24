import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { DIRECT_MODE_MAX_WINDOWS } from './shellGlobals.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';
import { getDraggedWindow } from './dragHelpers.js';
import { journal } from '../utils.js';

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
    _placeholder: null,
    _placeholderBox: null,
    _lastInsertion: null, // { box, index }
    _snapshot: null,      // { box, rects: [{window,x,width,mid,right}] }

    // ---- drag lifecycle (called by WindowIconButton) ----
    beginDrag(sourcePreview) {
        if (this._sourcePreview && this._sourcePreview !== sourcePreview)
            this.endDrag();
        this._sourcePreview = sourcePreview;
        this._snapshot = null;
        if (typeof sourcePreview.add_style_class_name === 'function')
            sourcePreview.add_style_class_name('reorder-drag-source');
        // NOTE: do NOT hide()/reparent the source here. dnd.js has already
        // taken `sourcePreview` itself as the flying drag actor and will
        // move it with the pointer.
    },

    endDrag() {
        this._clearPlaceholder();
        this._snapshot = null;
        if (this._sourcePreview) {
            try {
                this._sourcePreview.remove_style_class_name('reorder-drag-source');
            } catch (e) {
                // actor may already be destroyed
            }
        }
        this._sourcePreview = null;
    },

    clearIfRelated(actor) {
        if (this._sourcePreview === actor) {
            this._clearPlaceholder();
            this._snapshot = null;
            this._sourcePreview = null;
            return;
        }
        if (this._placeholderBox === actor)
            this._clearPlaceholder();
    },

    _snapshotRects(box, order, draggedWindow) {
        if (this._snapshot && this._snapshot.box === box)
            return this._snapshot.rects;

        const rects = [];
        for (const w of order) {
            if (w === draggedWindow)
                continue;
            const preview = box.get_children().find(c => c._window === w);
            if (!preview || !preview.get_stage())
                continue;
            const [x] = preview.get_transformed_position();
            const [width] = preview.get_transformed_size();
            rects.push({ window: w, x, width, mid: x + width / 2, right: x + width });
        }
        this._snapshot = { box, rects };
        return rects;
    },

    computeInsertionFromPointer(draggedWindow, order, pointerX, box) {
        const rects = this._snapshotRects(box, order, draggedWindow);
        if (rects.length === 0)
            return { insertIndex: 0 };

        const first = rects[0];
        const last = rects[rects.length - 1];
        let target = null;
        let insertBefore = true;

        if (pointerX < first.x) {
            target = first;
            insertBefore = true;
        } else if (pointerX >= last.right) {
            target = last;
            insertBefore = false;
        } else {
            for (const r of rects) {
                if (pointerX >= r.x && pointerX < r.right) {
                    target = r;
                    insertBefore = pointerX < r.mid;
                    break;
                }
            }
            if (!target) {
                for (let i = 0; i < rects.length - 1; i++) {
                    const left = rects[i], right = rects[i + 1];
                    if (pointerX >= left.right && pointerX <= right.x) {
                        const distanceToLeft = pointerX - left.right;
                        const distanceToRight = right.x - pointerX;
                        target = distanceToLeft <= distanceToRight ? left : right;
                        insertBefore = target === right;
                        break;
                    }
                }
            }
            if (!target) {
                let nearest = rects[0];
                let best = Math.abs(pointerX - nearest.mid);
                for (const r of rects) {
                    const d = Math.abs(pointerX - r.mid);
                    if (d < best) { best = d; nearest = r; }
                }
                target = nearest;
                insertBefore = pointerX < nearest.mid;
            }
        }

        const orderWithout = order.filter(w => w !== draggedWindow);
        let targetIndex = orderWithout.indexOf(target.window);
        if (targetIndex === -1)
            targetIndex = orderWithout.length;

        return { insertIndex: insertBefore ? targetIndex : targetIndex + 1 };
    },

    // ---- placeholder rendering ----
    updatePlaceholder(box, index) {
        if (!box)
            return;

        const count = box.get_children().length;
        const clamped = Math.max(0, Math.min(index, count));

        // Record the insertion target unconditionally, even when there's
        // no _sourcePreview to build a visual placeholder from. A drag
        // started from the collection search overlay never calls
        // beginDrag(), so _sourcePreview stays null — but the drop
        // location itself is still perfectly well-defined and acceptDrop()
        // reads it back via getLastInsertion() regardless of origin.
        const unchanged = this._placeholderBox === box && this._lastInsertion?.index === clamped;
        this._placeholderBox = box;
        this._lastInsertion = { box, index: clamped };

        if (!this._sourcePreview || unchanged)
            return;

        const placeholder = this._ensurePlaceholder();
        if (!placeholder)
            return;

        if (placeholder.get_parent())
            placeholder.get_parent().remove_child(placeholder);

        box.insert_child_at_index(placeholder, clamped);
    },

    clearPlaceholder() {
        this._clearPlaceholder();
    },

    getLastInsertion() {
        return this._lastInsertion;
    },

    _ensurePlaceholder() {
        if (this._placeholder)
            return this._placeholder;
        if (!this._sourcePreview)
            return null;
        const size = this._sourcePreview.icon_size ?? 96;
        const placeholder = new St.Bin({
            style_class: 'window-preview-icon drag-placeholder-icon',
            width: size,
            height: size,
        });
        placeholder.opacity = 140;
        const iconActor = this._sourcePreview.get_child();
        if (iconActor)
            placeholder.set_child(new Clutter.Clone({ source: iconActor }));
        this._placeholder = placeholder;
        return placeholder;
    },

    _clearPlaceholder() {
        if (!this._placeholder)
            return;
        if (this._placeholder.get_parent())
            this._placeholder.get_parent().remove_child(this._placeholder);
        this._placeholder.destroy();
        this._placeholder = null;
        this._placeholderBox = null;
        this._lastInsertion = null;
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
            const last = this.getLastInsertion();
            insertIndex = last && last.box === targetBox ? last.index : null;
            if (insertIndex === null) {
                journal(`[WindowReorderDragController] acceptDrop: no insertion recorded, rejecting`);
                this.clearPlaceholder();
                return false;
            }
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
            // No draggable per-window icon exists inside a collection-mode
            // thumbnail, so this path shouldn't normally be reachable —
            // but if it is, don't leave the actor for dnd.js to find
            // still sitting in Main.uiGroup.
            if (actor.get_parent() === Main.uiGroup)
                actor.get_parent().remove_child(actor);
            try { actor.destroy(); } catch (e) { /* already gone */ }
            return;
        }

        targetOrderStore.setSuppressSync(true);
        targetOrderStore.reorderWindowToIndex(draggedWindow, insertIndex);
        targetOrderStore.setSuppressSync(false);

        this._resetDragTransform(actor);
        if (actor.get_parent() === Main.uiGroup)
            actor.get_parent().remove_child(actor);
        targetBox.insert_child_at_index(actor, insertIndex);
        // Do NOT call sync() – the child order already matches the store.
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
            sourceThumbnail._orderStore.setSuppressSync(true);
            preview = sourceThumbnail._displayMode.releasePreview(draggedWindow);
            sourceThumbnail._orderStore.setSuppressSync(false);
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

            targetOrderStore.setSuppressSync(true);
            targetOrderStore.insertWindowImmediate(draggedWindow, insertIndex);
            targetOrderStore.setSuppressSync(false);
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

    _resetDragTransform(actor) {
        actor.set_scale(1, 1);
        actor.set_translation(0, 0, 0);
        actor.set_position(0, 0);
        actor.opacity = 255;
        actor.remove_style_class_name('reorder-drag-source');
    },
};