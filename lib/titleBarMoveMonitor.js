import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WorkspaceManager } from './shellGlobals.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';

import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

// ==================== TITLE BAR MOVE MONITOR ====================
export class TitleBarMoveMonitor {
    constructor() {
        this._grabbedWindow = null;
        this._dragPollId = 0;
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;

        this._beginId = global.display.connect('grab-op-begin',
            (display, window, op) => this._onGrabOpBegin(window, op));
        this._endId = global.display.connect('grab-op-end',
            (display, window, op) => this._onGrabOpEnd(window, op));

        this._sessionModeId = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.currentMode === 'unlock-dialog') {
                journal('[TitleBarMoveMonitor] session locked, resetting drag state');
                this.reset();
            }
        });
    }

    reset() {
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;
        this._stopDragPoll();
        WorkspaceThumbnailRegistry.hideAllNameHints();
        journal('[TitleBarMoveMonitor] reset complete');
    }

    _isMoveOp(op) {
        return op === Meta.GrabOp.MOVING ||
            op === Meta.GrabOp.KEYBOARD_MOVING;
    }

    _onGrabOpBegin(window, op) {
        if (!this._isMoveOp(op))
            return;
        journal(`[TitleBarMoveMonitor] Move grab started: ${window?.title}`);
        this._currentDragWindow = window;
        this._lastSwitchedWorkspace = null;
        this._startDragPoll();
    }

    _findThumbnailAt(x, y) {
        for (const thumb of WorkspaceThumbnailRegistry.getAll()) {
            if (!thumb.get_stage())
                continue;
            const [tx, ty] = thumb.get_transformed_position();
            const tw = thumb.width;
            const th = thumb.height;
            if (x >= tx && x <= tx + tw && y >= ty && y <= ty + th)
                return thumb;
        }
        return null;
    }

    // Moves `window` onto `thumb`'s workspace, appending it to that
    // workspace's icon order immediately — bypassing WindowOrderStore's
    // normal 200ms "settle" debounce. That debounce exists for windows
    // that just mapped, whose frame rect isn't settled yet; a window
    // already mid-title-bar-drag is already fully mapped and has valid
    // geometry, so there's nothing to wait on. Pre-inserting before
    // change_workspace() means the workspace's own window-added handler
    // just sees the window already present and no-ops — no duplicate,
    // no delay.
    _switchWindowToThumbnail(thumb, window) {
        const targetOrderStore = thumb._orderStore;
        if (!targetOrderStore.order.includes(window)) {
            targetOrderStore._insertWindowImmediate(window, targetOrderStore.order.length);
            targetOrderStore._emitOrderChanged();
        }

        const monitorIndex = Main.layoutManager.findIndexForActor(thumb);
        if (monitorIndex !== window.get_monitor()) window.move_to_monitor(monitorIndex);
        window.change_workspace(thumb.workspace);
        thumb.workspace.activate(global.get_current_time());
        this._lastSwitchedWorkspace = thumb.workspace;
    }

    _startDragPoll() {
        if (this._dragPollId) {
            GLib.Source.remove(this._dragPollId);
            this._dragPollId = 0;
        }
        journal(`[TitleBarMoveMonitor] Starting drag poll`);
        this._dragPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            100,
            () => this._onDragPollTick()
        );
    }

    _stopDragPoll() {
        if (this._dragPollId) {
            GLib.Source.remove(this._dragPollId);
            this._dragPollId = 0;
            journal(`[TitleBarMoveMonitor] Stopped drag poll`);
        }
    }

    _onDragPollTick() {
        if (!this._currentDragWindow) {
            this._stopDragPoll();
            return GLib.SOURCE_REMOVE;
        }

        const [px, py] = global.get_pointer();
        const thumb = this._findThumbnailAt(px, py);

        WorkspaceThumbnailRegistry.hideAllNameHints();
        thumb?.showNameHint();

        if (!thumb)
            return GLib.SOURCE_CONTINUE;

        const targetWs = thumb.workspace;
        const currentWs = WorkspaceManager.get_active_workspace();
        if (targetWs === currentWs || targetWs === this._lastSwitchedWorkspace)
            return GLib.SOURCE_CONTINUE;

        this._switchWindowToThumbnail(thumb, this._currentDragWindow);
        return GLib.SOURCE_CONTINUE;
    }

    _onGrabOpEnd(window, op) {
        const grabbed = this._currentDragWindow;
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;
        this._stopDragPoll();
        WorkspaceThumbnailRegistry.hideAllNameHints();

        if (!grabbed || grabbed !== window || !this._isMoveOp(op)) return;
        const [pointerX, pointerY] = global.get_pointer();
        const target = this._findThumbnailAt(pointerX, pointerY);
        // Covers the case where the drop happens fast enough that the
        // poll never caught it mid-drag — same fast path either way.
        if (target) this._switchWindowToThumbnail(target, window);
    }

    destroy() {
        this._stopDragPoll();
        if (this._beginId) {
            global.display.disconnect(this._beginId);
            this._beginId = null;
        }
        if (this._endId) {
            global.display.disconnect(this._endId);
            this._endId = null;
        }
        this._currentDragWindow = null;
        this._grabbedWindow = null;

        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = null;
        }
    }
}