// Tracks the last-focused window PER WORKSPACE. Needed because
// workspace.activate() does not reliably restore/refocus that
// workspace's last-used window on its own — this codebase's own
// window-click handlers explicitly call window.activate() after
// workspace.activate() for exactly this reason. So we can't just read
// global.display.focus_window right after switching workspace and
// expect it to reflect the workspace we just switched to.
export class FocusHistory {
    static _lastFocusedByWorkspace = new Map();
    static _signalId = 0;

    static init() {
        if (this._signalId) return;
        this._signalId = global.display.connect('notify::focus-window', () => {
            const win = global.display.focus_window;
            if (!win) return;
            const ws = win.get_workspace();
            if (!ws) return;
            this._lastFocusedByWorkspace.set(ws, win);
        });
    }

    // Last known focused window for `workspace`, or null if we have no
    // record (e.g. nothing focused there since the extension loaded).
    static getFocusedWindow(workspace) {
        return this._lastFocusedByWorkspace.get(workspace) ?? null;
    }

    static destroy() {
        if (this._signalId) {
            global.display.disconnect(this._signalId);
            this._signalId = 0;
        }
        this._lastFocusedByWorkspace.clear();
    }
}