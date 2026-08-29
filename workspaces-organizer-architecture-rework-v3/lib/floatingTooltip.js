import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ==================== SHARED FLOATING TOOLTIP ====================
// One "label centered above an actor" tooltip. Used for the workspace
// drag-over name hint, the pinned-app hover tooltip, and the pinned-app
// drag insertion hint — every floating label in the extension goes
// through this so they look and behave identically.
export class FloatingTooltip {
    constructor({ parent = null, styleClass = 'dmenu-tooltip', fontSize = null } = {}) {
        // `parent`: an actor to add_child the label to (e.g. the overlay's
        // own container). Omit to fall back to Main.layoutManager.addChrome(),
        // needed for anything shown outside a modal overlay's actor tree
        // (e.g. hovering over workspace thumbnails in the panel).
        this._parent = parent;
        this._label = new St.Label({ style_class: styleClass, visible: false });
        if (fontSize)
            this._label.set_style(`font-size: ${fontSize}pt;`);
        if (this._parent)
            this._parent.add_child(this._label);
        else
            Main.layoutManager.addChrome(this._label);
    }

    showAbove(actor, text, gap = 8) {
        this._label.set_text(text);
        this._label.show();

        const [width, height] = this._label.get_size();
        const [actorX, actorY] = actor.get_transformed_position(); // absolute stage coords
        const actorWidth = actor.get_width();
        const actorHeight = actor.get_height();

        const monitorIndex = Main.layoutManager.findIndexForActor(actor);
        const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;

        const edgePad = 6;
        const minX = monitor.x + edgePad;
        const maxX = monitor.x + monitor.width - width - edgePad;
        const minY = monitor.y + edgePad;
        const maxY = monitor.y + monitor.height - height - edgePad;

        let x = Math.round(actorX + (actorWidth - width) / 2);
        x = Math.max(minX, Math.min(x, maxX));

        let y = Math.round(actorY - height - gap);
        if (y < minY)
            y = Math.round(actorY + actorHeight + gap); // not enough room above — flip below
        y = Math.max(minY, Math.min(y, maxY));

        // The math above is in absolute stage coordinates. set_position()
        // is relative to whatever this label is parented under — for
        // addChrome() that's the stage itself, so no conversion needed.
        // But when parented inside an overlay's own container (e.g.
        // AppSearchOverlay._container), we have to subtract that
        // container's own stage position, or the tooltip lands in the
        // wrong place whenever the container isn't sitting at (0, 0)
        // (any non-primary or non-origin monitor).
        if (this._parent) {
            const [parentX, parentY] = this._parent.get_transformed_position();
            x -= parentX;
            y -= parentY;
        }

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
