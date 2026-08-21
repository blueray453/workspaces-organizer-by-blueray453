import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { WindowSearchOverlay } from './windowSearchOverlay.js';

// ==================== WINDOW OVERFLOW BUTTON ====================
// Replaces the row of individual icons once a workspace has more windows
// than DIRECT_MODE_MAX_WINDOWS. Shows a count; clicking opens the
// fuzzy-search WindowSearchOverlay over all of that workspace's windows.
export class WindowOverflowButton extends St.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(getWindowsFn) {
        super({
            style_class: 'workspace-thumbnail-collection-icon',
            reactive: true,
            track_hover: true,
            can_focus: true,
        });

        this._getWindowsFn = getWindowsFn;
        this._label = new St.Label({
            style_class: 'collection-icon-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._label);
        this._clickedId = this.connect('clicked', () => this._openOverlay());
    }

    setCount(count) {
        this._label.set_text(`▱ ${count}`);
    }

    _openOverlay() {
        const windows = this._getWindowsFn();
        new WindowSearchOverlay(windows);
    }

    destroy() {
        if (this._clickedId) {
            this.disconnect(this._clickedId);
            this._clickedId = null;
        }
        super.destroy();
    }
}