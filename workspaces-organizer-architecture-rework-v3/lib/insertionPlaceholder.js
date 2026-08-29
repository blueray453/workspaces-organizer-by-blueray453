import Clutter from 'gi://Clutter';
import St from 'gi://St';

// ==================== GENERIC INSERTION PLACEHOLDER ====================
// Shared "show exactly where a horizontally-dragged item will land"
// helper. Used by WindowReorderDragController (window icons inside a
// workspace thumbnail) and AppSearchOverlay (pinned app bar) so every
// reorderable icon strip in the extension computes insertion position
// and renders its ghost placeholder the same way.
export class InsertionPlaceholder {
    constructor() {
        this._box = null;
        this._placeholder = null;
        this._lastIndex = null;
        this._snapshot = null; // { box, rects }
    }

    _snapshotRects(box, items, excludeItem, actorOf) {
        if (this._snapshot && this._snapshot.box === box)
            return this._snapshot.rects;

        const rects = [];
        for (const item of items) {
            if (item === excludeItem) continue;
            const actor = actorOf(item);
            if (!actor || !actor.get_stage()) continue;
            const [x] = actor.get_transformed_position();
            const [width] = actor.get_transformed_size();
            rects.push({ item, x, width, mid: x + width / 2, right: x + width });
        }
        this._snapshot = { box, rects };
        return rects;
    }

    // Returns { index, neighbor, insertBefore }. `index` is where the
    // drop would land in the list of items WITHOUT excludeItem. `neighbor`
    // is the item the placeholder is landing next to (null if the strip
    // is empty), `insertBefore` says which side of it.
    computeInsertion(box, items, excludeItem, actorOf, pointerX) {
        const rects = this._snapshotRects(box, items, excludeItem, actorOf);
        if (rects.length === 0)
            return { index: 0, neighbor: null, insertBefore: true };

        const first = rects[0];
        const last = rects[rects.length - 1];
        let target = null;
        let insertBefore = true;

        if (pointerX < first.x) {
            target = first; insertBefore = true;
        } else if (pointerX >= last.right) {
            target = last; insertBefore = false;
        } else {
            for (const r of rects) {
                if (pointerX >= r.x && pointerX < r.right) {
                    target = r; insertBefore = pointerX < r.mid; break;
                }
            }
            if (!target) {
                for (let i = 0; i < rects.length - 1; i++) {
                    const left = rects[i], right = rects[i + 1];
                    if (pointerX >= left.right && pointerX <= right.x) {
                        target = (pointerX - left.right) <= (right.x - pointerX) ? left : right;
                        insertBefore = target === right;
                        break;
                    }
                }
            }
            if (!target) {
                let nearest = rects[0], best = Math.abs(pointerX - nearest.mid);
                for (const r of rects) {
                    const d = Math.abs(pointerX - r.mid);
                    if (d < best) { best = d; nearest = r; }
                }
                target = nearest; insertBefore = pointerX < nearest.mid;
            }
        }

        const orderedItems = rects.map(r => r.item);
        let targetIndex = orderedItems.indexOf(target.item);
        if (targetIndex === -1) targetIndex = orderedItems.length;

        return {
            index: insertBefore ? targetIndex : targetIndex + 1,
            neighbor: target.item,
            insertBefore,
        };
    }

    // Shows/moves a ghost placeholder inside `box` at `index`, cloning
    // `sourceActor`'s child so it visually matches whatever is being
    // dragged (window icon or pinned app icon alike).
    show(box, index, sourceActor, sizeHint = 96) {
        const count = box.get_children().length;
        const clamped = Math.max(0, Math.min(index, count));

        const unchanged = this._box === box && this._lastIndex === clamped;
        this._box = box;
        this._lastIndex = clamped;
        if (unchanged) return;

        const placeholder = this._ensurePlaceholder(sourceActor, sizeHint);
        if (!placeholder) return;

        if (placeholder.get_parent())
            placeholder.get_parent().remove_child(placeholder);
        box.insert_child_at_index(placeholder, clamped);
    }

    getLastIndex() { return this._lastIndex; }
    getBox() { return this._box; }

    _ensurePlaceholder(sourceActor, sizeHint) {
        if (this._placeholder) return this._placeholder;
        if (!sourceActor) return null;
        const size = sourceActor.icon_size ?? sizeHint;
        const placeholder = new St.Bin({
            style_class: 'drag-placeholder-icon',
            width: size,
            height: size,
        });
        placeholder.opacity = 140;
        const iconActor = sourceActor.get_child?.();
        if (iconActor)
            placeholder.set_child(new Clutter.Clone({ source: iconActor }));
        this._placeholder = placeholder;
        return placeholder;
    }

    clear() {
        if (this._placeholder) {
            if (this._placeholder.get_parent())
                this._placeholder.get_parent().remove_child(this._placeholder);
            this._placeholder.destroy();
        }
        this._placeholder = null;
        this._box = null;
        this._lastIndex = null;
        this._snapshot = null;
    }
}

// "Move before X" / "Move after Y" — the same phrasing shape used for
// every drag-insertion hint in the extension. `nameOf` extracts a
// display name from whatever item type the caller is reordering.
export function describeInsertion(insertion, nameOf) {
    if (!insertion.neighbor) return 'Pin here';
    const name = nameOf(insertion.neighbor);
    return insertion.insertBefore ? `Move before ${name}` : `Move after ${name}`;
}
