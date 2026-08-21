import { DIRECT_MODE_MAX_WINDOWS } from './shellGlobals.js';
import { WindowIconButton } from './windowIconButton.js';
import { WindowOverflowButton } from './windowOverflowButton.js';

// ==================== THUMBNAIL DISPLAY MODE CONTROLLER ====================
// Owns the switch between "direct" mode (one WindowIconButton per window)
// and "collection" mode (a single WindowOverflowButton) for one
// WorkspaceThumbnail's icon box, driven purely by WindowOrderStore's
// order length. The only class that creates/destroys WindowIconButtons.
export class ThumbnailDisplayModeController {
    constructor(box, orderStore, { onIconClicked } = {}) {
        this._box = box;
        this._orderStore = orderStore;
        this._onIconClicked = onIconClicked ?? (() => { });
        this._windowPreviews = new Map();
        this._collectionIcon = null;
        this._mode = 'direct';

        this._orderStore.setOnOrderChanged(() => this.sync());
        this.sync();
    }

    get mode() {
        return this._mode;
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
            this._collectionIcon = new WindowOverflowButton(() => this._orderStore.order.slice());
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

            const preview = new WindowIconButton(window);
            preview.connect('clicked', () => this._onIconClicked(window));

            this._windowPreviews.set(window, preview);
            this._box.add_child(preview);
        }

        this._mode = 'direct';
        this.syncChildOrder();
        this._updateThumbnailSize();
    }

    _updateThumbnailSize() {
        let iconSize = 96;
        const count = this._windowPreviews.size;
        if (count >= 7) iconSize = 48;
        else if (count >= 5) iconSize = 72;
        for (const preview of this._windowPreviews.values())
            preview.setIconSize(iconSize);
    }
}