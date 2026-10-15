import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {
    intent, buildModel, placeWindow, setIntent,
    onIntentChange, onWorldChange, resetIntent, getModelWindows, logModel,
    WorkspaceManager, Display, DIRECT_MODE_MAX_WINDOWS,
} from './model.js';
import { Scope, Coalescer } from './scheduling.js';
import {
    WindowIconController, createReorderGhost, createDropStrip, DragMotionResult,
    openContextMenu, getTooltip, settleIcon,
} from './interactions.js';
import {
    createToolbarButton, createWorkspaceNameLabel, createThumbnail,
    createOverflowButton, createWindowIconActor,
} from './ui.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

let _instance = null;
let _settleWindow = null;

export function thumbnailAt(x, y) { return _instance?._thumbnailAt(x, y) ?? null; }
export function settleOnNextRender(window) { _settleWindow = window; }

export class WorkspaceIndicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    /**
     * `commands` is the injection seam for anything that lives outside
     * this widget. The composition root (extension.js) supplies the real
     * implementations; nothing here imports overlayService.
     *
     *   commands = {
     *     showAllApps(),
     *     showAllWindows(),
     *     showWorkspaceWindows(index),
     *   }
     */
    constructor(settings, commands) {
        super(0.0, _('Workspace Indicator'));
        this.reactive = false;
        this._settings = settings;
        this._commands = commands;
        _instance = this;

        this._icons = [];
        this._scope = new Scope();
        this._renderCoalescer = new Coalescer(() => this._render());
        this._leavePollId = 0;

        this._lastHintWs = intent.hintWs;
        this._lastDragActive = !!intent.drag;
        this._lastMenuOpen = !!intent.menuOpen;

        this._ghost = createReorderGhost({
            iconSize: () => settings.get_int('icon-size'),
        });

        this._mainBox = new St.BoxLayout({
            style_class: 'workspace-indicator-main-box', y_expand: true, x_expand: true, reactive: true,
        });
        this.add_child(this._mainBox);

        onIntentChange(() => this._onIntentChanged());
        onWorldChange(() => this._queueRender());

        this._render();
    }

    _onIntentChanged() {
        const hintChanged = intent.hintWs !== this._lastHintWs;
        const isDragging = !!intent.drag;
        const isMenu = !!intent.menuOpen;
        const dragChanged = isDragging !== this._lastDragActive;
        const menuChanged = isMenu !== this._lastMenuOpen;

        this._lastHintWs = intent.hintWs;
        this._lastDragActive = isDragging;
        this._lastMenuOpen = isMenu;

        if (hintChanged) this._syncHint();
        if (dragChanged || menuChanged) this._queueRender();
    }

    _queueRender(delay = 0) { this._renderCoalescer.queue(delay); }

    // ==================== RENDER ====================
    _render() {
        if (intent.menuOpen) return;
        if (intent.drag) return;

        this._ghost.clear();
        this._destroyIcons();

        const model = buildModel();
        logModel(model);
        const s = this._settings;

        this._mainBox.destroy_all_children();
        this._settleActor = null;
        this._thumbsBox = null;

        const iconSize = s.get_int('toolbar-icon-size');
        if (s.get_boolean('show-drun-button')) {
            const b = createToolbarButton('view-app-grid-symbolic', iconSize, 'Show apps');
            b.connect('clicked', () => this._commands.showAllApps());
            this._mainBox.add_child(b);
        }
        if (s.get_boolean('show-window-button')) {
            const b = createToolbarButton('focus-windows-symbolic', iconSize, 'All windows');
            b.connect('clicked', () => this._commands.showAllWindows());
            this._mainBox.add_child(b);
        }
        if (s.get_boolean('show-workspace-names')) {
            this._mainBox.add_child(createWorkspaceNameLabel(
                Meta.prefs_get_workspace_name(WorkspaceManager.get_active_workspace_index()),
                s.get_int('workspace-name-font-size')));
        }

        this._thumbsBox = new St.BoxLayout({
            style_class: 'workspace-indicator-class', y_expand: true, x_expand: true, reactive: true,
        });
        for (const entry of model.workspaces)
            this._thumbsBox.add_child(this._buildThumbnail(entry));
        this._mainBox.add_child(this._thumbsBox);

        if (this._settleActor) settleIcon(this._settleActor);
        this._syncHint();
    }

    _destroyIcons() {
        for (const c of this._icons) c.destroy();
        this._icons = [];
    }

    _buildThumbnail(entry) {
        const s = this._settings;
        const { workspace, index, windows } = entry;
        const direct = windows.length <= DIRECT_MODE_MAX_WINDOWS;

        const { actor: thumb, box } = createThumbnail({
            minWidth: s.get_int('thumbnail-min-width'),
            active: index === WorkspaceManager.get_active_workspace_index(),
        });
        thumb._wsEntry = { workspace, index };

        const strip = createDropStrip({
            container: box,
            ghost: this._ghost,
            acceptSource: source => direct && source?._dragPayload?.kind === 'window',
            externalResult: DragMotionResult.MOVE_DROP,
            onDragOver: () => {
                this._ensureLeavePoll();
                setIntent({ hintWs: index }); // synchronously updates the name hint
            },
            onExternalDragOver: () => {
                if (workspace !== WorkspaceManager.get_active_workspace())
                    workspace.activate(global.get_current_time());
            },
            onDrop: (source, dropIndex, dragActor) =>
                this._dropOnWorkspace(thumb, workspace, direct, source, dropIndex, dragActor),
        });
        thumb._delegate = strip.delegate();

        thumb.connect('button-press-event', (actor, event) => {
            const b = event.get_button();
            if (b === Clutter.BUTTON_PRIMARY) workspace.activate(0);
            else if (b === Clutter.BUTTON_SECONDARY) this._openThumbnailMenu(thumb, workspace);
            return Clutter.EVENT_STOP;
        });

        if (!direct) {
            const overflow = createOverflowButton(windows.length);
            overflow.connect('clicked', () => this._commands.showWorkspaceWindows(index));
            box.add_child(overflow);
            return thumb;
        }

        const iconSize = s.get_int('icon-size');
        for (const w of windows) {
            const { actor, icon } = createWindowIconActor(w, iconSize);
            box.add_child(actor);
            this._icons.push(new WindowIconController({
                window: w, actor, icon, settings: s,
                strip, onRequestRender: () => this._queueRender(),
            }));
            if (w === _settleWindow) { _settleWindow = null; this._settleActor = actor; }
        }
        return thumb;
    }

    _syncHint() {
        const s = this._settings;
        const wsIndex = intent.hintWs;
        const target = (wsIndex !== null && this._thumbsBox)
            ? this._thumbsBox.get_child_at_index(wsIndex)
            : null;
        if (!target || !s.get_boolean('show-workspace-names')) {
            getTooltip().hide();
            return;
        }
        getTooltip().showAbove(
            target,
            Meta.prefs_get_workspace_name(wsIndex),
            s.get_int('tooltip-font-size'));
    }

    _openThumbnailMenu(anchor, workspace) {
        const windows = getModelWindows(workspace);
        openContextMenu(anchor, menu => {
            menu.addAction('Close all windows on all workspaces', () => {
                const now = global.get_current_time();
                for (const w of getModelWindows(null)) w.delete(now);
            });
            if (windows.length > 0) {
                menu.addAction(`Close all windows except workspace ${workspace.index()}`, () => {
                    const now = global.get_current_time();
                    for (const w of getModelWindows(null).filter(w => w.get_workspace() !== workspace))
                        w.delete(now);
                });
                menu.addAction(`Close all windows on workspace ${workspace.index()}`, () => {
                    const now = global.get_current_time();
                    for (const w of windows) w.delete(now);
                });
            }
        });
    }

    _dropOnWorkspace(thumb, workspace, direct, source, dropIndex, dragActor) {
        setIntent({ hintWs: null });

        const win = source?._dragPayload?.window ?? null;
        if (!win) return true;

        const sameWs = win.get_workspace() === workspace;

        if (dragActor && dragActor !== source._actor) {
            dragActor.get_parent()?.remove_child(dragActor);
            try { dragActor.destroy(); } catch (e) { /* ignore */ }
        }

        if (sameWs && !direct) { setIntent({ drag: null }); return true; }

        placeWindow(win, workspace, direct ? dropIndex : null);
        if (!sameWs) {
            const monitorIndex = Main.layoutManager.findIndexForActor(thumb);
            if (monitorIndex !== win.get_monitor()) win.move_to_monitor(monitorIndex);
            win.change_workspace(workspace);
        }
        _settleWindow = win;
        setIntent({ drag: null });
        return true;
    }

    _ensureLeavePoll() {
        if (this._leavePollId) return;
        this._leavePollId = this._scope.timeout(100, () => {
            const [px, py, mods] = global.get_pointer();
            const held = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
            if (!held || !this._thumbnailAt(px, py)) {
                this._leavePollId = 0;
                setIntent({ hintWs: null });
                this._ghost.clear();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _thumbnailAt(x, y) {
        if (!this._thumbsBox) return null;
        for (const thumb of this._thumbsBox.get_children()) {
            if (!thumb.get_stage() || !thumb._wsEntry) continue;
            const [tx, ty] = thumb.get_transformed_position();
            const [tw, th] = thumb.get_transformed_size();
            if (x >= tx && x <= tx + tw && y >= ty && y <= ty + th)
                return { ...thumb._wsEntry, actor: thumb };
        }
        return null;
    }

    // ==================== LIFECYCLE ====================
    destroy() {
        this._renderCoalescer.cancel();
        onIntentChange(null);
        onWorldChange(null);
        resetIntent();

        this._destroyIcons();
        this._ghost.clear();
        this._ghost = null;
        _instance = null;

        this._scope.dispose();
        this._mainBox?.destroy();
        Main.panel.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        super.destroy();
    }
}

// ==================== TITLE BAR MOVE MONITOR ====================
// Listens for native mutter window-move grabs (dragging by the title bar)
// and, if the pointer is over one of our thumbnails, moves the window
// there. Pointer updates come from Meta.CursorTracker's
// `position-invalidated`, which fires on every motion event even during a
// window-move grab. Co-located with the indicator because that's the UI it
// interacts with — `thumbnailAt` / `settleOnNextRender` are module exports
// right above.
export class TitleBarMoveMonitor {
    constructor() {
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;
        this._cursorTracker = global.backend.get_cursor_tracker();
        this._cursorPositionId = 0;

        this._beginId = Display.connect('grab-op-begin',
            (display, window, op) => this._onGrabOpBegin(window, op));
        this._endId = Display.connect('grab-op-end',
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
        this._stopGrabTracking();
        setIntent({ hintWs: null });
    }

    _isMoveOp(op) { return op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING; }

    _onGrabOpBegin(window, op) {
        if (!this._isMoveOp(op)) return;
        this._currentDragWindow = window;
        this._lastSwitchedWorkspace = null;
        this._startGrabTracking();
    }

    _onGrabOpEnd(window, op) {
        const grabbed = this._currentDragWindow;
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;
        this._stopGrabTracking();
        setIntent({ hintWs: null });

        if (!grabbed || grabbed !== window || !this._isMoveOp(op)) return;

        // Final check on release in case the last signal missed the release point.
        const [x, y] = this._getPointerPosition();
        const target = thumbnailAt(x, y);
        if (target) this._moveWindowTo(target, window);
    }

    _startGrabTracking() {
        this._stopGrabTracking();
        if (!this._cursorTracker) return;
        this._cursorPositionId = this._cursorTracker.connect('position-invalidated',
            () => this._onCursorPositionInvalidated());
    }

    _stopGrabTracking() {
        if (this._cursorPositionId && this._cursorTracker) {
            this._cursorTracker.disconnect(this._cursorPositionId);
            this._cursorPositionId = 0;
        }
    }

    _onCursorPositionInvalidated() {
        if (!this._currentDragWindow) return;

        const [x, y] = this._getPointerPosition();
        const thumb = thumbnailAt(x, y);
        setIntent({ hintWs: thumb ? thumb.index : null });
        if (!thumb) return;

        const ws = thumb.workspace;
        if (ws === WorkspaceManager.get_active_workspace() || ws === this._lastSwitchedWorkspace) return;
        this._moveWindowTo(thumb, this._currentDragWindow);
    }

    _getPointerPosition() {
        if (this._cursorTracker) {
            try {
                const [point] = this._cursorTracker.get_pointer();
                return [point.x, point.y];
            } catch (e) { journal(`[TitleBarMoveMonitor] get_pointer failed: ${e}`); }
        }
        return global.get_pointer();
    }

    // Append to the target's order, move the window, switch there. The
    // indicator re-renders from the resulting workspace events — nothing
    // to patch by hand.
    _moveWindowTo(thumb, window) {
        const ws = thumb.workspace;
        const alreadyThere = window.get_workspace() === ws;

        if (!alreadyThere) {
            placeWindow(window, ws, null);
            settleOnNextRender(window);
        }
        const monitorIndex = Main.layoutManager.findIndexForActor(thumb.actor);
        if (monitorIndex !== window.get_monitor()) window.move_to_monitor(monitorIndex);
        window.change_workspace(ws);
        ws.activate(global.get_current_time());
        this._lastSwitchedWorkspace = ws;
    }

    destroy() {
        this._stopGrabTracking();
        if (this._beginId) { Display.disconnect(this._beginId); this._beginId = null; }
        if (this._endId) { Display.disconnect(this._endId); this._endId = null; }
        if (this._sessionModeId) { Main.sessionMode.disconnect(this._sessionModeId); this._sessionModeId = null; }
        this._currentDragWindow = null;
    }
}