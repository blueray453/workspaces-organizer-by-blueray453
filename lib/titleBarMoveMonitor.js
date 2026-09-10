import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';
import { WindowIconButton } from './windowIconButton.js';

import { WorkspaceManager } from './shellGlobals.js';

import { settleIcon } from './animationHelpers.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== TITLE BAR MOVE MONITOR ====================
// Listens for native mutter window-move grabs (dragging a window by its
// title bar) and, on release, checks whether the pointer is over one of
// our workspace thumbnails. If so, moves the window there using the same
// normal GNOME window-move machinery already used by internal DND drops.
//
// Pointer updates during the grab come from Meta.CursorTracker's
// `position-invalidated` signal — mutter calls
// meta_cursor_tracker_invalidate_position on every motion event,
// including during a window-move grab.
export class TitleBarMoveMonitor {
    constructor() {
        this._grabbedWindow = null;
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;

        this._cursorTracker = this._getCursorTracker();
        this._cursorPositionId = 0;

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

        journal(`[TitleBarMoveMonitor] Initialized (cursorTracker=${this._cursorTracker ? 'yes' : 'no'})`);
    }

    _getCursorTracker() {
        try {
            if (typeof Meta.CursorTracker.get_for_display === 'function')
                return Meta.CursorTracker.get_for_display(global.display);
        } catch (e) {
            journal(`[TitleBarMoveMonitor] Meta.CursorTracker.get_for_display failed: ${e}`);
        }
        try {
            if (global.backend && typeof global.backend.get_cursor_tracker === 'function')
                return global.backend.get_cursor_tracker();
        } catch (e) {
            journal(`[TitleBarMoveMonitor] global.backend.get_cursor_tracker failed: ${e}`);
        }
        journal('[TitleBarMoveMonitor] No Meta.CursorTracker available');
        return null;
    }

    reset() {
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;
        this._stopGrabTracking();
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
        this._startGrabTracking();
    }

    _onGrabOpEnd(window, op) {
        const grabbed = this._currentDragWindow;
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;
        this._stopGrabTracking();
        WorkspaceThumbnailRegistry.hideAllNameHints();

        if (!grabbed || grabbed !== window || !this._isMoveOp(op)) return;

        // Final position check on release: if the last signal update missed
        // the exact release point, this catches it.
        const [pointerX, pointerY] = this._getPointerPosition();
        const target = this._findThumbnailAt(pointerX, pointerY);
        if (target) this._switchWindowToThumbnail(target, window);
    }

    // ==================== GRAB TRACKING ====================

    _startGrabTracking() {
        this._stopGrabTracking();

        if (!this._cursorTracker) {
            journal('[TitleBarMoveMonitor] No cursor tracker — cannot track pointer during grab');
            return;
        }

        this._cursorPositionId = this._cursorTracker.connect('position-invalidated',
            () => this._onCursorPositionInvalidated());
        journal('[TitleBarMoveMonitor] Connected to position-invalidated');
    }

    _stopGrabTracking() {
        if (this._cursorPositionId && this._cursorTracker) {
            this._cursorTracker.disconnect(this._cursorPositionId);
            this._cursorPositionId = 0;
        }
    }

    _onCursorPositionInvalidated() {
        if (!this._currentDragWindow)
            return;

        const [px, py] = this._getPointerPosition();
        const thumb = this._findThumbnailAt(px, py);

        WorkspaceThumbnailRegistry.hideAllNameHints();
        thumb?.showNameHint();

        if (!thumb)
            return;

        const targetWs = thumb.workspace;
        const currentWs = WorkspaceManager.get_active_workspace();
        if (targetWs === currentWs || targetWs === this._lastSwitchedWorkspace)
            return;

        this._switchWindowToThumbnail(thumb, this._currentDragWindow);
    }

    // ==================== POINTER / THUMBNAIL ====================

    _getPointerPosition() {
        if (this._cursorTracker) {
            try {
                const [point] = this._cursorTracker.get_pointer();
                return [point.x, point.y];
            } catch (e) {
                journal(`[TitleBarMoveMonitor] get_pointer failed: ${e}`);
            }
        }
        return global.get_pointer();
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

    // ==================== THUMBNAIL SWITCH ====================

    _switchWindowToThumbnail(thumb, window) {
        const targetOrderStore = thumb._orderStore;
        const targetDisplay = thumb._displayMode;
        const targetBox = thumb._windowsBox;
        const alreadyPresent = targetOrderStore.order.includes(window);

        if (!alreadyPresent)
            targetOrderStore._insertWindowImmediate(window, targetOrderStore.order.length);

        const monitorIndex = Main.layoutManager.findIndexForActor(thumb);
        if (monitorIndex !== window.get_monitor()) window.move_to_monitor(monitorIndex);
        window.change_workspace(thumb.workspace);
        thumb.workspace.activate(global.get_current_time());
        this._lastSwitchedWorkspace = thumb.workspace;

        if (alreadyPresent)
            return;

        const willStayDirect = targetDisplay.wouldStayDirect(targetOrderStore.order.length);
        if (willStayDirect) {
            const newIcon = new WindowIconButton(window, targetDisplay._settings);
            newIcon.connect('clicked', () => targetDisplay._onIconClicked(window));
            targetBox.add_child(newIcon);
            targetDisplay._windowPreviews.set(window, newIcon);
            settleIcon(newIcon);
        } else {
            targetOrderStore._emitOrderChanged();
        }
    }

    destroy() {
        this._stopGrabTracking();
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