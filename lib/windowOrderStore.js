import GLib from 'gi://GLib';
import { Display, TimeoutDelay } from './shellGlobals.js';

// ==================== WINDOW ORDER STORE ====================
// Pure bookkeeping for one workspace's window list and its user-defined
// display order — no actors, no rendering. Listens to the workspace for
// windows appearing/disappearing and exposes a single `order` array plus
// a change callback. ThumbnailDisplayModeController and WorkspaceThumbnail
// are the only things that read from it.
export class WindowOrderStore {
    constructor(workspace) {
        this._workspace = workspace;
        this._order = [];
        this._pendingInsertIndices = new Map();
        this._addWindowTimeoutIds = new Map();
        this._onOrderChanged = null;

        this._windowAddedId = workspace.connect('window-added', (ws, win) => this._addWindow(win));
        this._windowRemovedId = workspace.connect('window-removed', (ws, win) => this._removeWindow(win));
        this._windowCreatedId = Display.connect('window-created', (display, win) => {
            if (win.get_workspace() === this._workspace)
                this._addWindow(win);
        });

        this._workspace.list_windows().forEach(w => this._addWindow(w));
    }

    get workspace() {
        return this._workspace;
    }

    // Current display order. Callers may read this freely but must not
    // mutate it directly — use reorderWindowToIndex()/setPendingInsertIndex().
    get order() {
        return this._order;
    }

    setOnOrderChanged(callback) {
        this._onOrderChanged = callback;
    }

    reorderWindowToIndex(window, insertIndex) {
        if (insertIndex === null)
            return;

        const currentIndex = this._order.indexOf(window);
        if (currentIndex === -1) {
            if (window.get_workspace() === this._workspace) {
                const idx = Math.max(0, Math.min(insertIndex, this._order.length));
                this._order.splice(idx, 0, window);
                this._emitOrderChanged();
            }
            return;
        }

        this._order.splice(currentIndex, 1);
        const idx = Math.max(0, Math.min(insertIndex, this._order.length));
        this._order.splice(idx, 0, window);
        this._emitOrderChanged();
    }

    setPendingInsertIndex(window, index) {
        this._pendingInsertIndices.set(window, index);
    }

    cleanupSources() {
        for (const [, id] of this._addWindowTimeoutIds)
            GLib.Source.remove(id);
        this._addWindowTimeoutIds.clear();
    }

    destroy() {
        this.cleanupSources();
        this._pendingInsertIndices.clear();
        if (this._windowAddedId)
            this._workspace.disconnect(this._windowAddedId);
        if (this._windowRemovedId)
            this._workspace.disconnect(this._windowRemovedId);
        if (this._windowCreatedId)
            Display.disconnect(this._windowCreatedId);
    }

    _addWindow(window) {
        if (window.skip_taskbar)
            return;

        if (this._order.includes(window)) {
            this._pendingInsertIndices.delete(window);
            return;
        }

        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }

        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
            this._addWindowTimeoutIds.delete(window);

            if (window.get_workspace() !== this._workspace)
                return GLib.SOURCE_REMOVE;

            if (!this._order.includes(window)) {
                if (this._pendingInsertIndices.has(window)) {
                    const idx = Math.max(
                        0,
                        Math.min(this._pendingInsertIndices.get(window), this._order.length)
                    );
                    this._order.splice(idx, 0, window);
                } else {
                    this._order.push(window);
                }
            }

            this._pendingInsertIndices.delete(window);
            this._emitOrderChanged();
            return GLib.SOURCE_REMOVE;
        });

        this._addWindowTimeoutIds.set(window, sourceId);
    }

    _removeWindow(window) {
        this._pendingInsertIndices.delete(window);

        if (this._addWindowTimeoutIds.has(window)) {
            GLib.Source.remove(this._addWindowTimeoutIds.get(window));
            this._addWindowTimeoutIds.delete(window);
        }

        const idx = this._order.indexOf(window);
        if (idx === -1)
            return;

        this._order.splice(idx, 1);
        this._emitOrderChanged();
    }

    _emitOrderChanged() {
        this._onOrderChanged?.();
    }
}