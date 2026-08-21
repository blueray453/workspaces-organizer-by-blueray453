import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { createClonePreviewActor } from './clonePreviewActor.js';
import { screenHeight, TimeoutDelay } from './shellGlobals.js';
import { journal } from '../utils.js';

export class WindowHoverPreview {
    constructor(anchorActor, window, settings, { onHoverChange } = {}) {
        this._anchor = anchorActor;
        this._window = window;
        this._settings = settings;
        this._onHoverChange = onHoverChange ?? (() => { });
        this._previewActor = null;
        this._isShowing = false;
    }

    isShowing() {
        return this._isShowing;
    }

    isHovered() {
        return this._previewActor?.hover ?? false;
    }

    show() {
        if (this._isShowing)
            return;

        const previewHeight = this._settings.get_int('hover-preview-height');
        const built = createClonePreviewActor(this._window, previewHeight, {
            wrapperStyleClass: 'hover-preview-wrapper',
            showTitle: false,
            onClose: (win) => {
                win.delete(global.get_current_time());
                this.hide();
            },
            closeButtonSize: this._settings.get_int('close-button-size'),
            closeButtonOffsetX: 60,
            closeButtonOffsetY: 10,
            onHoverChange: (isHovered) => this._onHoverChange(isHovered),
            onActivate: () => {
                this._window.get_workspace().activate_with_focus(this._window, 0);
                this.hide();
            },
        });

        if (!built)
            return;

        const anchorWidth = this._anchor.get_width();
        const [anchorX] = this._anchor.get_transformed_position();
        const previewX = Math.max(0, anchorX + (anchorWidth - built.width) / 2);
        const previewY = screenHeight - previewHeight - 200 + 55;

        built.actor.set_position(previewX, previewY);
        this._previewActor = built.actor;
        Main.layoutManager.addChrome(this._previewActor);

        this._previewActor.opacity = 0;
        this._previewActor.ease({
            opacity: 255,
            duration: TimeoutDelay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._isShowing = true;
        journal(`[WindowHoverPreview] Shown`);
    }

    hide() {
        if (!this._isShowing)
            return;
        if (this._previewActor) {
            const actor = this._previewActor;
            this._previewActor = null;
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._isShowing = false;
        journal(`[WindowHoverPreview] Hidden`);
    }

    destroy() {
        this.hide();
    }
}