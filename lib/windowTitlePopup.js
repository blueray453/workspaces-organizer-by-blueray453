import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { screenWidth, screenHeight, TimeoutDelay } from './shellGlobals.js';
import { journal } from '../utils.js';

// ==================== WINDOW TITLE POPUP ====================
// The small floating title label shown instead of the hover preview while
// CTRL is held. Same show()/hide()/isShowing()/isHovered() shape as
// WindowHoverPreview so the coordinator can treat them interchangeably.
export class WindowTitlePopup {
    constructor(anchorActor, window, { onHoverChange } = {}) {
        this._anchor = anchorActor;
        this._window = window;
        this._onHoverChange = onHoverChange ?? (() => { });
        this._popupActor = null;
        this._isShowing = false;
        this._hoverSignalId = null;
    }

    isShowing() {
        return this._isShowing;
    }

    isHovered() {
        return this._popupActor?.hover ?? false;
    }

    show() {
        if (this._isShowing)
            return;

        const title = this._window.get_title() || 'Untitled Window';
        const label = new St.Label({
            text: title,
            style_class: 'hover-title-popup',
            reactive: true,
            track_hover: true,
        });
        Main.layoutManager.addChrome(label);

        const [iconX] = this._anchor.get_transformed_position();
        const iconWidth = this._anchor.width;
        const padding = 10;
        const maxWidth = screenWidth - (2 * padding);
        const labelWidth = Math.min(label.width, maxWidth);
        let labelX = iconX + (iconWidth - labelWidth) / 2;
        labelX = Math.max(padding, labelX);
        labelX = Math.min(labelX, screenWidth - labelWidth - padding);
        const labelY = screenHeight - 200;

        label.set_position(labelX, labelY);
        this._popupActor = label;

        label.opacity = 0;
        label.ease({
            opacity: 255,
            duration: TimeoutDelay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._hoverSignalId = label.connect('notify::hover', () => {
            this._onHoverChange(label.hover);
        });

        this._isShowing = true;
        journal(`[WindowTitlePopup] Shown`);
    }

    hide() {
        if (!this._isShowing)
            return;
        if (this._popupActor) {
            const actor = this._popupActor;
            this._popupActor = null;
            if (this._hoverSignalId) {
                actor.disconnect(this._hoverSignalId);
                this._hoverSignalId = null;
            }
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._isShowing = false;
        journal(`[WindowTitlePopup] Hidden`);
    }

    destroy() {
        this.hide();
    }
}