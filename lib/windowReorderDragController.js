import Clutter from 'gi://Clutter';
import St from 'gi://St';

// ==================== WINDOW REORDER DRAG CONTROLLER ====================
// Single owner of the whole "drag a window icon to reorder/move it" visual
// flow: the semi-transparent + blue-bordered dragged icon, the ghost
// placeholder that shows where it will land, and the insertion-index math
// both the empty-space and icon-to-icon hover paths need. WorkspaceThumbnail
// and WindowIconButton only ever call the public methods below — neither
// owns any placeholder actor or insertion math itself. Singleton.
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
        // move it with the pointer — that IS the "icon moves to its future
        // position during drag" behavior. Hiding it here would collapse its
        // old slot immediately and desync our own pointer hit-testing.
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

    // Called from destroy() paths so a destroyed actor is never touched again.
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

    // Rects for every remaining (non-dragged) preview in `box`, measured
    // ONCE per box per drag — the first time this box is asked about.
    // Reused afterwards so our own placeholder's presence (which shifts
    // sibling icons) never feeds back into the next tick's measurement.
    // This is what prevents the icon-A/icon-B position flicker.
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

    // Single source of truth for "given this pointer X over this box,
    // where should the dragged window land?" Used by both the empty-space
    // hover path and the icon-to-icon hover path.
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
        if (!this._sourcePreview || !box)
            return;
        if (this._placeholderBox === box && this._lastInsertion?.index === index)
            return;

        const placeholder = this._ensurePlaceholder();
        if (!placeholder)
            return;

        if (placeholder.get_parent())
            placeholder.get_parent().remove_child(placeholder);

        const count = box.get_children().length;
        const clamped = Math.max(0, Math.min(index, count));
        box.insert_child_at_index(placeholder, clamped);

        this._placeholderBox = box;
        this._lastInsertion = { box, index: clamped };
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
        placeholder.opacity = 140; // semi-transparent
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
};