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

        // Listen for changes to the icon-size setting
        this._settingsChangeId = this._settings.connect('changed::icon-size', () => {
            this._updateAllIconSizes();
        });

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
        // Disconnect the settings signal
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

        // Ensure all existing previews have the current icon size
        this._updateAllIconSizes();
    }

    /**
     * Update the icon size of all existing previews to the current setting.
     * Called when the 'icon-size' setting changes.
     */
    _updateAllIconSizes() {
        const iconSize = this._settings.get_int('icon-size');
        for (const preview of this._windowPreviews.values()) {
            preview.setIconSize(iconSize);
        }
    }
}