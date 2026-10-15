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

// Bursts of window events (rapid close/open) coalesce into one render per
// this interval. Renders are idempotent, so dropping intermediates is safe.
const MIN_RENDER_INTERVAL_MS = 100;

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

        // Live WindowIconControllers, keyed by `${windowId}:${wsIndex}`.
        //
        // Keyed per workspace, not per window, because `buildModel()` lists
        // a sticky window (`on_all_workspaces`) in every workspace's window
        // array. A single window-keyed controller would be reparented into a
        // second workspace's box, which Clutter rejects (an actor can only
        // have one parent), so the icon would show only in the first
        // workspace and its strip pointer would get clobbered.
        //
        // Reuse is the whole point: constructing a controller wires ~10
        // signals and a DND draggable. Doing that once per (window,
        // workspace) appearance instead of once per render is the difference
        // between ~250 signal connects per render and ~0.
        this._controllers = new Map();
        this._lastIconSize = undefined;
        this._lastRenderTime = undefined;
        this._toolbarKey = null;
        this._staticBox = null;
        this._nameLabel = null;
        this._thumbsBox = null;

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

    _queueRender(delay = 0) {
        const now = GLib.get_monotonic_time() / 1000;
        const since = now - (this._lastRenderTime ?? 0);
        if (since < MIN_RENDER_INTERVAL_MS)
            delay = Math.max(delay, MIN_RENDER_INTERVAL_MS - since);
        this._renderCoalescer.queue(delay);
    }

    // ==================== RENDER ====================
    _render() {
        if (intent.menuOpen) return;
        if (intent.drag) return;

        this._ghost.clear();

        const model = buildModel();
        logModel(model);
        const s = this._settings;

        // Icon-size change invalidates every window icon actor: wipe the
        // controller map so the next pass rebuilds at the new size.
        const iconSize = s.get_int('icon-size');
        if (this._lastIconSize !== undefined && this._lastIconSize !== iconSize) {
            for (const ctrl of this._controllers.values()) ctrl.destroy();
            this._controllers.clear();
        }
        this._lastIconSize = iconSize;

        // Detach surviving icon actors from their current parents before we
        // destroy _thumbsBox, so rebuilding the box doesn't cascade-destroy
        // them. Controllers stay alive across renders; only their parent
        // changes.
        for (const ctrl of this._controllers.values()) {
            const parent = ctrl.actor.get_parent();
            if (parent) parent.remove_child(ctrl.actor);
        }

        // Static toolbar: rebuilt only when a setting that shapes it changes.
        const toolbarKey = [
            s.get_boolean('show-drun-button'),
            s.get_boolean('show-window-button'),
            s.get_boolean('show-workspace-names'),
            s.get_int('toolbar-icon-size'),
            s.get_int('workspace-name-font-size'),
        ].join('|');
        if (this._toolbarKey !== toolbarKey) {
            this._toolbarKey = toolbarKey;
            this._buildToolbar(s);
        }
        if (this._nameLabel) {
            this._nameLabel.set_text(Meta.prefs_get_workspace_name(
                WorkspaceManager.get_active_workspace_index()));
        }

        // Dynamic part: only the thumbnails are rebuilt every render.
        this._thumbsBox?.destroy();
        this._settleActor = null;
        this._thumbsBox = new St.BoxLayout({
            style_class: 'workspace-indicator-class', y_expand: true, x_expand: true, reactive: true,
        });

        const seen = new Set();
        for (const entry of model.workspaces)
            this._thumbsBox.add_child(this._buildThumbnail(entry, seen));
        this._mainBox.add_child(this._thumbsBox);

        // Prune controllers whose (window, workspace) pairs are gone.
        for (const [key, ctrl] of this._controllers) {
            if (!seen.has(key)) {
                ctrl.destroy();
                this._controllers.delete(key);
            }
        }

        if (this._settleActor) settleIcon(this._settleActor);
        this._syncHint();

        this._lastRenderTime = GLib.get_monotonic_time() / 1000;
    }

    _buildToolbar(s) {
        if (!this._staticBox) {
            this._staticBox = new St.BoxLayout({ y_expand: true });
            this._mainBox.add_child(this._staticBox);
        }
        this._staticBox.destroy_all_children();
        this._nameLabel = null;

        const iconSize = s.get_int('toolbar-icon-size');
        if (s.get_boolean('show-drun-button')) {
            const b = createToolbarButton('view-app-grid-symbolic', iconSize, 'Show apps');
            b.connect('clicked', () => this._commands.showAllApps());
            this._staticBox.add_child(b);
        }
        if (s.get_boolean('show-window-button')) {
            const b = createToolbarButton('focus-windows-symbolic', iconSize, 'All windows');
            b.connect('clicked', () => this._commands.showAllWindows());
            this._staticBox.add_child(b);
        }
        if (s.get_boolean('show-workspace-names')) {
            this._nameLabel = createWorkspaceNameLabel(
                Meta.prefs_get_workspace_name(WorkspaceManager.get_active_workspace_index()),
                s.get_int('workspace-name-font-size'));
            this._staticBox.add_child(this._nameLabel);
        }
    }

    _buildThumbnail(entry, seen) {
        const s = this._settings;
        const { workspace, index, windows } = entry;
        const direct = windows.length <= DIRECT_MODE_MAX_WINDOWS;

        // Mark every (window, workspace) pair as live, even ones we're not
        // showing right now (overflow mode). Keeps their controllers around
        // so switching back to direct mode is instant.
        for (const w of windows) seen.add(`${w.get_id()}:${index}`);

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
                setIntent({ hintWs: index });
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
            const key = `${w.get_id()}:${index}`;
            let ctrl = this._controllers.get(key);

            // The controller captured its icon texture and drag gicon at
            // construction. A window that appeared before its wm-class was
            // known keeps the fallback icon forever unless we rebuild. The
            // notify::wm-class handler below marks the controller stale; the
            // actual teardown happens here, on the next render, so we never
            // destroy a controller from inside its own signal dispatch.
            if (ctrl?.stale) {
                ctrl.destroy();
                this._controllers.delete(key);
                ctrl = undefined;
            }

            if (ctrl) {
                // Reuse: reparent the live actor into the new box and point
                // it at the fresh strip.
                box.add_child(ctrl.actor);
                ctrl.setStrip(strip);
            } else {
                const { actor, icon } = createWindowIconActor(w, iconSize);
                box.add_child(actor);
                ctrl = new WindowIconController({
                    window: w, actor, icon, settings: s,
                    strip,
                    onRequestRender: () => { ctrl.stale = true; this._queueRender(); },
                });
                this._controllers.set(key, ctrl);
            }

            if (w === _settleWindow) { _settleWindow = null; this._settleActor = ctrl.actor; }
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

        for (const ctrl of this._controllers.values()) ctrl.destroy();
        this._controllers.clear();

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