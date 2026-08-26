import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ==================== SHARED FLOATING TOOLTIP ====================
// One "label centered above an actor" tooltip. Used for the workspace
// drag-over name hint, the pinned-app hover tooltip, and the pinned-app
// drag insertion hint — every floating label in the extension goes
// through this so they look and behave identically.
export class FloatingTooltip {
    constructor({ parent = null, styleClass = 'dmenu-tooltip' } = {}) {
        // `parent`: an actor to add_child the label to (e.g. the overlay's
        // own container). Omit to fall back to Main.layoutManager.addChrome(),
        // needed for anything shown outside a modal overlay's actor tree
        // (e.g. hovering over workspace thumbnails in the panel).
        this._parent = parent;
        this._label = new St.Label({ style_class: styleClass, visible: false });
        if (this._parent)
            this._parent.add_child(this._label);
        else
            Main.layoutManager.addChrome(this._label);
    }

    showAbove(actor, text, gap = 8) {
        this._label.set_text(text);
        this._label.show();
        const [width, height] = this._label.get_size();
        const [actorX, actorY] = actor.get_transformed_position();
        const actorWidth = actor.get_width();
        const x = Math.round(actorX + (actorWidth - width) / 2);
        const y = Math.round(actorY - height - gap);
        this._label.set_position(x, y);
    }

    hide() { this._label.hide(); }

    destroy() {
        if (this._parent) {
            if (this._label.get_parent() === this._parent)
                this._parent.remove_child(this._label);
        } else {
            Main.layoutManager.removeChrome(this._label);
        }
        this._label.destroy();
    }
}
