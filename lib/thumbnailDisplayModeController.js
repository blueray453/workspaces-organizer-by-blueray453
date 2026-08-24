import { DIRECT_MODE_MAX_WINDOWS } from './shellGlobals.js';
import { WindowIconButton } from './windowIconButton.js';
import { WindowOverflowButton } from './windowOverflowButton.js';

export class ThumbnailDisplayModeController {
    constructor(box, orderStore, settings, { onIconClicked } = {}) {
        this._box = box;
        this._orderStore = orderStore;
        this._settings = settings;
        this._onIconClicked = onIconClicked ?? (() => { });
        this._windowPreviews = new Map();
        this._collectionIcon = null;
        this._mode = 'direct';

        this._settingsChangeId = this._settings.connect('changed::icon-size', () => {
            this._updateAllIconSizes();
        });

        this._orderStore.setOnOrderChanged(() => this.sync());
        this.sync();
    }

    get mode() {
        return this._mode;
    }

    // Whether inserting one more window would keep this thumbnail in
    // direct mode. WindowReorderDragController checks this BEFORE taking
    // the adoptPreview() fast path — adoptPreview only knows how to slot
    // one icon into an already-direct box; it has no concept of the
    // direct/collection threshold and can't perform the collapse into a
    // single overflow button. Crossing the threshold must go through
    // sync() instead.
    wouldStayDirect(prospectiveCount) {
        return prospectiveCount <= DIRECT_MODE_MAX_WINDOWS;
    }

    sync() {
        const count = this._orderStore.order.length;
        if (count > DIRECT_MODE_MAX_WINDOWS)
            this._enterCollectionMode(count);
        else
            this._enterDirectMode();
    }

    syncChildOrder() {
        if (this._mode !== 'direct' || !this._box)
            return;

        const orderedPreviews = [];
        for (const window of this._orderStore.order) {
            const preview = this._windowPreviews.get(window);
            if (!preview)
                continue;
            if (preview.get_parent() === this._box)
                this._box.remove_child(preview);
            orderedPreviews.push(preview);
        }
        for (const preview of orderedPreviews)
            this._box.add_child(preview);
    }

    destroy() {
        if (this._settingsChangeId) {
            this._settings.disconnect(this._settingsChangeId);
            this._settingsChangeId = null;
        }

        for (const preview of this._windowPreviews.values()) {
            if (preview.get_parent() === this._box)
                this._box.remove_child(preview);
            preview.destroy();
        }
        this._windowPreviews.clear();
        if (this._collectionIcon) {
            if (this._collectionIcon.get_parent() === this._box)
                this._box.remove_child(this._collectionIcon);
            this._collectionIcon.destroy();
            this._collectionIcon = null;
        }
    }

    _enterCollectionMode(count) {
        for (const preview of this._windowPreviews.values()) {
            if (preview.get_parent() === this._box)
                this._box.remove_child(preview);
            preview.destroy();
        }
        this._windowPreviews.clear();

        if (!this._collectionIcon) {
            this._collectionIcon = new WindowOverflowButton(
                () => this._orderStore.order.slice(),
                this._settings
            );
            this._box.add_child(this._collectionIcon);
        }
        this._collectionIcon.setCount(count);
        this._mode = 'collection';
    }

    _enterDirectMode() {
        if (this._collectionIcon) {
            if (this._collectionIcon.get_parent() === this._box)
                this._box.remove_child(this._collectionIcon);
            this._collectionIcon.destroy();
            this._collectionIcon = null;
        }

        const currentWindows = new Set(this._orderStore.order);

        for (const [window, preview] of this._windowPreviews) {
            if (!currentWindows.has(window)) {
                if (preview.get_parent() === this._box)
                    this._box.remove_child(preview);
                preview.destroy();
                this._windowPreviews.delete(window);
            }
        }

        for (const window of this._orderStore.order) {
            if (this._windowPreviews.has(window))
                continue;
            if (!this._box || !this._box.get_stage())
                continue;

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
        for (const preview of this._windowPreviews.values()) {
            preview.setIconSize(iconSize);
        }
    }

    // Detach a window's preview from this box without destroying it.
    // Used by WindowReorderDragController when transplanting a window to
    // another thumbnail mid-drop — the actor is still owned by dnd.js and
    // must not be torn down. Returns null in collection mode (no
    // individual previews exist there) — callers must handle that.
    releasePreview(window) {
        const preview = this._windowPreviews.get(window);
        if (!preview)
            return null;
        this._windowPreviews.delete(window);
        if (preview.get_parent() === this._box)
            this._box.remove_child(preview);
        return preview;
    }

    // Take ownership of a preview released from another controller and
    // place it directly at `index`, bypassing the normal create-on-sync
    // path. Caller must have already confirmed wouldStayDirect() and
    // reset the actor's DND-applied transform.
    adoptPreview(window, preview, index) {
        if (!this._box)
            return;
        preview.setIconSize(this._settings.get_int('icon-size'));
        this._windowPreviews.set(window, preview);
        const count = this._box.get_children().length;
        const clamped = Math.max(0, Math.min(index, count));
        this._box.insert_child_at_index(preview, clamped);
    }
}