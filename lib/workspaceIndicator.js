import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { showAllWindows, showAllApps, showWorkspaceWindows } from './overlayService.js';
import {
    intent, buildModel, placeWindow, setIntent, setDragTarget,
    onIntentChange, onWorldChange, requestRender, resetIntent,
    getModelWindows, logModel,
} from './model.js';
import {
    DragMotionResult, ReorderGhostController, DropStrip, createClonePreviewActor,
    evictWindowIcon, getWindowApp, getWindowAppIcon, iconForWindow, hideTooltip,
    makeDraggable, openContextMenu, showTooltipAbove,
} from './ui.js';
import {
    WorkspaceManager, Display, TimeoutDelay, DIRECT_MODE_MAX_WINDOWS, screenWidth, screenHeight,
} from './shellGlobals.js';
import { Scope, Coalescer } from './scheduling.js';
import { fadeInActor, settleIcon } from './animationHelpers.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

let _instance = null;
let _settleWindow = null;

export function thumbnailAt(x, y) { return _instance?._thumbnailAt(x, y) ?? null; }
export function settleOnNextRender(window) { _settleWindow = window; }

// ==================== ACTIVE PREVIEW TRACKER ====================
class ActivePreviewTracker {
    static activePreview = null;
    static _ctrlPollId = null;
    static _ctrlPressed = false;

    static register(preview) {
        if (this.activePreview && this.activePreview !== preview)
            this.activePreview.forceHidePreview();
        this.activePreview = preview;
        this._startPoll();
    }

    static unregister(preview) {
        if (this.activePreview === preview) {
            this.activePreview = null;
            this._stopPoll();
        }
    }

    static _readCtrl() {
        const [, , mods] = global.get_pointer();
        return (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
    }

    static _startPoll() {
        if (this._ctrlPollId || !this.activePreview) return;
        this._ctrlPressed = this._readCtrl();
        this._ctrlPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
            if (!this.activePreview) { this._ctrlPollId = null; return GLib.SOURCE_REMOVE; }
            const ctrl = this._readCtrl();
            if (ctrl !== this._ctrlPressed) {
                this._ctrlPressed = ctrl;
                this.activePreview?.onCtrlChanged(ctrl);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    static _stopPoll() {
        if (this._ctrlPollId) { GLib.Source.remove(this._ctrlPollId); this._ctrlPollId = null; }
    }
}

// ==================== EXTERNAL DRAG AUTO-ACTIVATOR ====================
class ExternalDragAutoActivator {
    constructor(window) {
        this._window = window;
        this._scope = new Scope();
        this._id = 0;
        this._lastHover = 0;
    }

    notify() {
        this._lastHover = GLib.get_monotonic_time();
        if (this._id) return;
        this._id = this._scope.timeout(400, () => {
            this._id = 0;
            if ((GLib.get_monotonic_time() - this._lastHover) / 1000 > 500)
                return GLib.SOURCE_REMOVE;
            const win = this._window;
            if (win.minimized) win.unminimize();
            win.get_workspace().activate_with_focus(win, global.get_current_time());
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() { this._scope.dispose(); }
}

// ==================== WINDOW ICON ====================
class WindowIcon {
    constructor(window, settings, strip) {
        this._window = window;
        this._settings = settings;
        this._strip = strip;
        this._preview = null;
        this._popup = null;
        this._scope = new Scope();
        this._dragActivator = new ExternalDragAutoActivator(window);

        const actor = this.actor = new St.Button({
            style_class: 'window-preview-icon', reactive: true, track_hover: true,
        });
        actor._icon = this;

        const iconSize = settings.get_int('icon-size');
        this._setIcon(iconSize);

        // Forward DnD to the strip; the strip classifies. Shell passes the
        // delegate as `source`; external sources trigger the auto-activator.
        const delegate = {
            handleDragOver: (source, ...rest) => {
                if (source === actor._delegate) return DragMotionResult.CONTINUE;
                if (!source?._dragPayload?.window) this._dragActivator.notify();
                return strip.handleDragOver(source, ...rest);
            },
            acceptDrop: (source, ...rest) => strip.acceptDrop(source, ...rest),
        };

        makeDraggable(actor, {
            iconSize,
            payload: { kind: 'window', window, gicon: getWindowAppIcon(window) },
            delegate,
            onDragBegin: () => setIntent({ drag: { window, sourceIcon: actor, target: null } }),
            onDragEnd: () => setIntent({ drag: null, hintWs: null }),
        });

        this._scope.connect(actor, 'notify::hover', () => this._onHoverChange());
        this._scope.connect(actor, 'button-press-event', (a, e) => this._onButtonPressed(e));
        this._scope.connect(actor, 'button-release-event', (a, e) => this._onButtonReleased(e));

        this._scope.connect(window, 'notify::wm-class', () => requestRender());
        this._scope.connect(window, 'notify::mapped', () => requestRender());
        this._scope.connect(window, 'notify::appears-focused', () => {
            if (window.appears_focused) actor.add_style_class_name('focused');
            else actor.remove_style_class_name('focused');
        });

        if (window.appears_focused) actor.add_style_class_name('focused');
    }

    _setIcon(iconSize) {
        const iconActor = iconForWindow(this._window, iconSize);
        this.actor.set_child(iconActor);

        // set_icon_geometry is only meaningful while on stage; reconnect on
        // each parenting.
        const id = iconActor.connect('stage-views-changed', () => {
            const rect = new Meta.Rectangle();
            [rect.x, rect.y] = iconActor.get_transformed_position();
            [rect.width, rect.height] = iconActor.get_transformed_size();
            this._window.set_icon_geometry(rect);
            iconActor.disconnect(id);
        });
    }

    // ---------- hover preview / title popup ----------
    _isShowing() { return !!(this._preview || this._popup); }

    onCtrlChanged(ctrl) {
        if (ctrl) { this._showPopup(); this._hidePreview(); }
        else { this._showPreview(); this._hidePopup(); }
    }

    forceHidePreview() {
        this._stopCleanup();
        ActivePreviewTracker.unregister(this);
        this._hidePreview();
        this._hidePopup();
    }

    _onHoverChange() {
        if (this._hoverTimeoutId) { this._scope.cancel(this._hoverTimeoutId); this._hoverTimeoutId = 0; }
        if (intent.drag) return;
        if (this.actor.hover) {
            this._stopCleanup();
            if (this._isShowing()) { this.onCtrlChanged(ActivePreviewTracker._ctrlPressed); return; }
            this._hoverTimeoutId = this._scope.timeout(30, () => {
                this._hoverTimeoutId = 0;
                ActivePreviewTracker.register(this);
                if (this.actor.hover || this._isShowing()) {
                    if (ActivePreviewTracker._ctrlPressed) this._showPopup();
                    else this._showPreview();
                }
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._isShowing()) {
            this._startCleanup();
        }
    }

    _onPreviewHover(isHovered) {
        if (isHovered) this._stopCleanup();
        else if (!this.actor.hover) this._startCleanup();
    }

    _startCleanup() {
        this._stopCleanup();
        this._cleanupId = this._scope.timeout(TimeoutDelay, () => {
            this._cleanupId = 0;
            if (this.actor.hover || this._preview?.hover || this._popup?.hover)
                return GLib.SOURCE_REMOVE;
            ActivePreviewTracker.unregister(this);
            this._hidePreview();
            this._hidePopup();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopCleanup() {
        if (this._cleanupId) { this._scope.cancel(this._cleanupId); this._cleanupId = 0; }
    }

    _showPreview() {
        if (this._preview) return;
        const win = this._window;
        const previewHeight = this._settings.get_int('hover-preview-height');
        const built = createClonePreviewActor(win, previewHeight, {
            wrapperStyleClass: 'hover-preview-wrapper',
            showTitle: false,
            onClose: w => { w.delete(global.get_current_time()); this._hidePreview(); },
            closeButtonSize: this._settings.get_int('close-button-size'),
            closeButtonOffsetX: 60,
            closeButtonOffsetY: 10,
            onHoverChange: h => this._onPreviewHover(h),
            onActivate: () => {
                win.get_workspace().activate_with_focus(win, 0);
                this._hidePreview();
            },
        });
        if (!built) return;

        const anchorWidth = this.actor.get_width();
        const [anchorX] = this.actor.get_transformed_position();
        const previewX = Math.max(0, anchorX + (anchorWidth - built.width) / 2);
        const previewY = screenHeight - previewHeight - 200 + 55;

        built.actor.set_position(previewX, previewY);
        this._preview = built.actor;
        Main.layoutManager.addChrome(this._preview);
        fadeInActor(this._preview);
    }

    _hidePreview() {
        if (!this._preview) return;
        const actor = this._preview;
        this._preview = null;
        Main.layoutManager.removeChrome(actor);
        actor.destroy();
    }

    _showPopup() {
        if (this._popup) return;
        const title = this._window.get_title() || 'Untitled Window';
        const label = new St.Label({ text: title, style_class: 'hover-title-popup', reactive: true, track_hover: true });
        label.set_style(`font-size: ${this._settings.get_int('title-popup-font-size')}pt;`);
        Main.layoutManager.addChrome(label);

        const [iconX] = this.actor.get_transformed_position();
        const padding = 10;
        const labelWidth = Math.min(label.width, screenWidth - 2 * padding);
        let labelX = iconX + (this.actor.width - labelWidth) / 2;
        labelX = Math.max(padding, Math.min(labelX, screenWidth - labelWidth - padding));
        label.set_position(labelX, screenHeight - 200);

        this._popup = label;
        fadeInActor(label);
        label.connect('notify::hover', () => this._onPreviewHover(label.hover));
    }

    _hidePopup() {
        if (!this._popup) return;
        const actor = this._popup;
        this._popup = null;
        Main.layoutManager.removeChrome(actor);
        actor.destroy();
    }

    // ---------- clicks ----------
    _onButtonPressed(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this.forceHidePreview();
            this._openMenu();
            return Clutter.EVENT_STOP;
        }
        return button === Clutter.BUTTON_PRIMARY ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _onButtonReleased(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;

        this.forceHidePreview();
        const win = this._window;
        const winWs = win.get_workspace();
        if (winWs === WorkspaceManager.get_active_workspace()) {
            if (win.minimized) { win.unminimize(); win.activate_with_workspace(0, winWs); }
            else if (!win.appears_focused || this._isCovered(win)) win.activate_with_workspace(0, winWs);
            else win.minimize();
        } else {
            winWs.activate_with_focus(win, 0);
        }
        return Clutter.EVENT_STOP;
    }

    _openMenu() {
        const win = this._window;
        const menu = openContextMenu(this.actor, m => {
            m.addAction(`Activate ${win.title}`, () => win.get_workspace().activate_with_focus(win, 0));
            m.addAction(`Close ${win.title}`, () => win.delete(0));
            m.addAction(`Close Except ${win.title}`, () => {
                const wmClass = win.get_wm_class();
                const others = getModelWindows(win.get_workspace())
                    .filter(w => w !== win && w.get_wm_class() === wmClass && w.get_wm_class_instance() !== 'file_progress');
                const now = global.get_current_time();
                for (const w of others) w.delete(now);
            });

            const app = getWindowApp(win);
            if (!app) return;
            m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const favorites = AppFavorites.getAppFavorites();
            const isFav = favorites.isFavorite(app.get_id());
            m.addAction(isFav ? `Unpin ${app.get_name()}` : `Pin ${app.get_name()}`, () => {
                if (isFav) favorites.removeFavorite(app.get_id());
                else favorites.addFavorite(app.get_id());
            });

            const appInfo = app.get_app_info();
            const actions = appInfo?.list_actions();
            if (actions && actions.length > 0) {
                m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                for (const action of actions)
                    m.addAction(`${appInfo.get_action_name(action)}`, () => app.launch_action(action, 0, -1));
            }
        }, { translationY: -35 });
    }

    _isCovered(window) {
        if (window.minimized) return false;
        const workspace = WorkspaceManager.get_active_workspace();
        const stacked = Display.sort_windows_by_stacking(
            Display.list_all_windows().filter(w =>
                !w.minimized &&
                (w.get_window_type() === Meta.WindowType.NORMAL || w.get_window_type() === Meta.WindowType.DIALOG) &&
                w.get_workspace() === workspace));

        const index = stacked.indexOf(window);
        if (index === -1) return false;

        const area = workspace.get_work_area_for_monitor(window.get_monitor());
        const clip = r => ({
            l: Math.max(r.x, area.x), t: Math.max(r.y, area.y),
            r: Math.min(r.x + r.width, area.x + area.width),
            b: Math.min(r.y + r.height, area.y + area.height),
        });

        const t = clip(window.get_frame_rect());
        if (t.r <= t.l || t.b <= t.t) return false;

        for (let i = index + 1; i < stacked.length; i++) {
            const other = stacked[i];
            if (other.get_transient_for() === window) continue;
            const o = clip(other.get_frame_rect());
            if (o.r <= o.l || o.b <= o.t) continue;
            if (t.l < o.r && t.r > o.l && t.t < o.b && t.b > o.t) return true;
        }
        return false;
    }

    destroy() {
        this.forceHidePreview();
        if (this._hoverTimeoutId) { this._scope.cancel(this._hoverTimeoutId); this._hoverTimeoutId = 0; }
        this._dragActivator.destroy();
        this._scope.dispose();
        this._strip = null;
        evictWindowIcon(this._window);
    }
}

// ==================== WORKSPACE INDICATOR ====================
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

        this._ghost = new ReorderGhostController({
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

    // ---------- intent / world ----------
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

    // ==================== THE RENDER ====================
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
        if (s.get_boolean('show-drun-button'))
            this._mainBox.add_child(this._toolbarButton('view-app-grid-symbolic', iconSize, 'Show apps', () => showAllApps()));
        if (s.get_boolean('show-window-button'))
            this._mainBox.add_child(this._toolbarButton('focus-windows-symbolic', iconSize, 'All windows', () => showAllWindows()));
        if (s.get_boolean('show-workspace-names')) {
            const name = new St.Label({
                style_class: 'workspace-name-label',
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                text: Meta.prefs_get_workspace_name(WorkspaceManager.get_active_workspace_index()),
            });
            name.set_style(`font-size: ${s.get_int('workspace-name-font-size')}px;`);
            this._mainBox.add_child(name);
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

    _toolbarButton(iconName, size, accessibleName, onClicked) {
        const button = new St.Button({
            style_class: 'workspace-toolbar-button',
            accessible_name: accessibleName,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({ icon_name: iconName, icon_size: size }),
        });
        button.connect('clicked', onClicked);
        return button;
    }

    _buildThumbnail(entry) {
        const { workspace, index, windows } = entry;
        const s = this._settings;

        const thumb = new St.Button({ style_class: 'workspace-thumbnail', x_expand: true, y_expand: true });
        thumb.set_style(`min-width: ${s.get_int('thumbnail-min-width')}px;`);
        if (index === WorkspaceManager.get_active_workspace_index())
            thumb.add_style_class_name('active');
        thumb._wsEntry = { workspace, index };

        const box = new St.BoxLayout();
        thumb.set_child(box);
        const direct = windows.length <= DIRECT_MODE_MAX_WINDOWS;

        const strip = new DropStrip({
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
            if (b === Clutter.BUTTON_SECONDARY) this._openThumbnailMenu(thumb, workspace);
            return Clutter.EVENT_STOP;
        });

        if (!direct) {
            const overflow = new St.Button({
                style_class: 'workspace-thumbnail-collection-icon', reactive: true, track_hover: true, can_focus: true,
            });
            overflow.set_child(new St.Label({
                style_class: 'collection-icon-label',
                text: `▱ ${windows.length}`,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            overflow.connect('clicked', () => showWorkspaceWindows(index));
            box.add_child(overflow);
            return thumb;
        }

        for (const w of windows) {
            const icon = new WindowIcon(w, s, strip);
            box.add_child(icon.actor);
            this._icons.push(icon);
            if (w === _settleWindow) { _settleWindow = null; this._settleActor = icon.actor; }
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
            hideTooltip();
            return;
        }
        showTooltipAbove(target,
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

    // ==================== DnD ====================
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