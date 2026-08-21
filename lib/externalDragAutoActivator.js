import GLib from 'gi://GLib';
import { journal } from '../utils.js';

// ==================== EXTERNAL DRAG AUTO-ACTIVATOR ====================
// Lets you drag a file/text/tab from elsewhere, hover over a window icon,
// and have the underlying window raise+focus so you can then drop onto
// the actual window surface. Unrelated to our own icon-reorder drags.
export class ExternalDragAutoActivator {
    constructor(window) {
        this._window = window;
        this._timeoutId = null;
        this._lastHoverTime = 0;
    }

    notifyDragOver() {
        this._lastHoverTime = GLib.get_monotonic_time();

        if (!this._timeoutId) {
            journal(`[ExternalDragAutoActivator] External drag hovering, scheduling activate`);
            this._timeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                400,
                () => {
                    this._timeoutId = null;
                    const elapsedMs = (GLib.get_monotonic_time() - this._lastHoverTime) / 1000;
                    if (elapsedMs > 500) {
                        journal(`[ExternalDragAutoActivator] Drag left before activation, aborting`);
                        return GLib.SOURCE_REMOVE;
                    }
                    this._activateWindow();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    _activateWindow() {
        if (!this._window) return;
        journal(`[ExternalDragAutoActivator] Activating window for drag-hover: ${this._window.title}`);
        const win = this._window;
        if (win.minimized) win.unminimize();
        win.get_workspace().activate_with_focus(win, global.get_current_time());
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }
}