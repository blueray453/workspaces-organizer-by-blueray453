import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { TimeoutDelay } from './shellGlobals.js';
import { journal } from '../utils.js';

// ==================== ACTIVE PREVIEW TRACKER ====================
// Centralized manager for "which WindowIconButton currently has its hover
// preview or title popup open" plus the shared CTRL-key poll that decides
// which of the two to show. Only one preview can be active at a time, and
// polling only runs while one is active — no dangling timers when idle.
// Singleton.
export const ActivePreviewTracker = {
    activePreview: null,
    _ctrlPollId: null,
    _ctrlPressed: false,

    registerPreview(preview) {
        journal(`[ActivePreviewTracker] Registering preview for window: ${preview.window.title}`);
        if (this.activePreview && this.activePreview !== preview) {
            journal(`[ActivePreviewTracker] Cleaning up previous preview`);
            this.activePreview.forceHidePreview('new preview registered');
        }
        this.activePreview = preview;
        this._startCtrlPoll();
    },

    unregisterPreview(preview) {
        if (this.activePreview === preview) {
            journal(`[ActivePreviewTracker] Unregistering preview for window: ${preview.window.title}`);
            this.activePreview = null;
            this._stopCtrlPoll();
        }
    },

    _checkCtrlKeyState() {
        const [, , mods] = global.get_pointer();
        this._ctrlPressed = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
    },

    _startCtrlPoll() {
        if (this._ctrlPollId) {
            journal(`[ActivePreviewTracker] Ctrl poll already running`);
            return;
        }
        if (!this.activePreview) {
            journal(`[ActivePreviewTracker] No active preview, skipping Ctrl poll`);
            return;
        }
        this._checkCtrlKeyState();
        journal(`[ActivePreviewTracker] Starting Ctrl poll, initial state: ${this._ctrlPressed}`);
        this._ctrlPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TimeoutDelay,
            () => this._onCtrlPollTick()
        );
    },

    _stopCtrlPoll() {
        if (this._ctrlPollId) {
            const sourceId = this._ctrlPollId;
            this._ctrlPollId = null;
            if (GLib.Source.remove(sourceId))
                journal(`[ActivePreviewTracker] Stopped Ctrl poll`);
        }
    },

    _onCtrlPollTick() {
        if (!this.activePreview) {
            journal(`[ActivePreviewTracker] No active preview, stopping Ctrl poll`);
            this._stopCtrlPoll();
            return GLib.SOURCE_REMOVE;
        }
        const [, , mods] = global.get_pointer();
        const ctrlDown = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrlDown !== this._ctrlPressed) {
            this._ctrlPressed = ctrlDown;
            journal(`[ActivePreviewTracker] Ctrl state changed: ${this._ctrlPressed}`);
            if (this.activePreview)
                this.activePreview.onCtrlChanged(ctrlDown);
        }
        return GLib.SOURCE_CONTINUE;
    },

    getCurrentCtrlState() {
        return this._ctrlPressed;
    },

    destroy() {
        journal(`[ActivePreviewTracker] Destroying`);
        this._stopCtrlPoll();
        this.activePreview = null;
    },
};