import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WorkspaceManager } from './shellGlobals.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';

import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

// ==================== TITLE BAR MOVE MONITOR ====================
// Listens for native mutter window-move grabs (dragging a window by its
// title bar) and, on release, checks whether the pointer is over one of
// our workspace thumbnails. If so, moves the window there using the same
// normal GNOME window-move machinery already used by internal DND drops.
// This is NOT the same pipeline as DND.makeDraggable: title-bar drags are
// a compositor-level grab operation, not a Clutter/St DND session, so
// dnd.js never observes them and we must hook global.display directly.
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

    _onGrabOpEnd(window, op) {
        const grabbed = this._currentDragWindow;
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;
        this._stopDragPoll();

        if (!grabbed || grabbed !== window || !this._isMoveOp(op))
            return;

        const [pointerX, pointerY] = global.get_pointer();
        const target = this._findThumbnailAt(pointerX, pointerY);
        if (target) {
            journal(`[TitleBarMoveMonitor] Dropped "${window.title}" onto workspace ${target.workspaceIndex}`);
            target.moveWindowHere(window);
        }
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
        if (!thumb)
            return GLib.SOURCE_CONTINUE;

        const targetWs = thumb.workspace;
        const currentWs = WorkspaceManager.get_active_workspace();

        if (targetWs === currentWs || targetWs === this._lastSwitchedWorkspace)
            return GLib.SOURCE_CONTINUE;

        journal(`[TitleBarMoveMonitor] Hover switch to workspace ${targetWs.index()}`);

        const window = this._currentDragWindow;
        const monitorIndex = Main.layoutManager.findIndexForActor(thumb);
        if (monitorIndex !== window.get_monitor())
            window.move_to_monitor(monitorIndex);

        window.change_workspace(targetWs);
        targetWs.activate(global.get_current_time());
        this._lastSwitchedWorkspace = targetWs;

        return GLib.SOURCE_CONTINUE;
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
    }
}