import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { showAllWindows, showAllApps, showWorkspaceWindows } from './overlayService.js';
import {
    intent, buildModel, placeWindow, setIntent,
    onIntentChange, onWorldChange, resetIntent, getModelWindows, logModel,
} from './model.js';
import { WorkspaceManager, DIRECT_MODE_MAX_WINDOWS } from './shellGlobals.js';
import { Scope, Coalescer } from './scheduling.js';
import { settleIcon } from './animationHelpers.js';
import {
    WindowIconController, ReorderGhost, DropStrip, DragMotionResult,
    openContextMenu, getTooltip,
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

    constructor(settings) {
        super(0.0, _('Workspace Indicator'));
        this.reactive = false;
        this._settings = settings;
        _instance = this;

        this._icons = [];
        this._scope = new Scope();
        this._renderCoalescer = new Coalescer(() => this._render());
        this._leavePollId = 0;

        this._lastHintWs = intent.hintWs;
        this._lastDragActive = !!intent.drag;
        this._lastMenuOpen = !!intent.menuOpen;

        this._ghost = new ReorderGhost({
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
            b.connect('clicked', () => showAllApps());
            this._mainBox.add_child(b);
        }
        if (s.get_boolean('show-window-button')) {
            const b = createToolbarButton('focus-windows-symbolic', iconSize, 'All windows');
            b.connect('clicked', () => showAllWindows());
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

        const strip = new DropStrip({
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
            overflow.connect('clicked', () => showWorkspaceWindows(index));
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