import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { showAllWindows, showAllApps, showWorkspaceWindows } from './overlayService.js';
import {
    intent, buildModel, placeWindow, setIntent, setDragTarget,
    onIntentChange, requestRender, resetIntent,
    getModelWindows, logModel,
} from './model.js';
import {
    DragMotionResult, FloatingTooltip, computeInsertion, createClonePreviewActor,
    createGhostIcon, createWindowIconTexture, getWindowApp, getWindowAppIcon,
    makeWindowDraggable, openContextMenu, closeActiveMenu,
} from './ui.js';
import {
    WorkspaceManager, Display, TimeoutDelay, DIRECT_MODE_MAX_WINDOWS, screenWidth, screenHeight,
} from './shellGlobals.js';
import { fadeInActor, settleIcon } from './animationHelpers.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

let _instance = null;
let _settleWindow = null; // transient: pop this window's icon in on next render

// Used by TitleBarMoveMonitor.
export function thumbnailAt(x, y) { return _instance?._thumbnailAt(x, y) ?? null; }
export function settleOnNextRender(window) { _settleWindow = window; }

// ==================== ICON TEXTURE CACHE ====================
// window -> { widget: St.Widget, size: number }
// Reuses the resolved icon widget across renders and only regenerates when
// the requested size changes or the entry is evicted (window destroyed).
const _iconCache = new WeakMap();

function _evictIcon(window) {
    _iconCache.delete(window);
}

function _getCachedIcon(window, iconSize) {
    const entry = _iconCache.get(window);
    if (!entry || entry.size !== iconSize) return null;
    return entry.widget;
}

function _setCachedIcon(window, iconSize, widget) {
    _iconCache.set(window, { widget, size: iconSize });
}

// ==================== ACTIVE PREVIEW TRACKER ====================
// Only one icon has its hover preview / title popup open at a time; the
// CTRL poll (which swaps between them) only runs while one is active.
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

// Hovering an EXTERNAL drag (files, text) over an icon for ~400 ms raises its window.
class ExternalDragAutoActivator {
    constructor(window) { this._window = window; this._timeoutId = 0; this._lastHover = 0; }

    notifyDragOver() {
        this._lastHover = GLib.get_monotonic_time();
        if (this._timeoutId) return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._timeoutId = 0;
            if ((GLib.get_monotonic_time() - this._lastHover) / 1000 > 500)
                return GLib.SOURCE_REMOVE;
            const win = this._window;
            if (win.minimized) win.unminimize();
            win.get_workspace().activate_with_focus(win, global.get_current_time());
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._timeoutId) { GLib.Source.remove(this._timeoutId); this._timeoutId = 0; }
    }
}

// ==================== WINDOW ICON ====================
// A plain object wrapping one St.Button. Created fresh on every render;
// it owns hover preview / title popup / context menu for its window.
class WindowIcon {
    constructor(window, settings) {
        this._window = window;
        this._settings = settings;
        this._hooks = null; // { handleDragOver, acceptDrop } from the owning thumbnail
        this._preview = null;
        this._popup = null;
        this._hoverTimeoutId = 0;
        this._cleanupId = 0;
        this._dragActivator = new ExternalDragAutoActivator(window);

        const actor = this.actor = new St.Button({
            style_class: 'window-preview-icon', reactive: true, track_hover: true,
        });
        actor._icon = this;

        const iconSize = settings.get_int('icon-size');
        this._setIcon(iconSize);

        // Forward DnD to the thumbnail behind us; the thumbnail classifies.
        // NOTE: Shell passes the draggable's actor._delegate as `source`.
        const delegate = {
            handleDragOver: (source, a, x, y, time) => {
                if (source === actor._delegate) return DragMotionResult.CONTINUE;
                if (!source?._window) this._dragActivator.notifyDragOver();
                return this._hooks?.handleDragOver(source, a, x, y, time) ?? DragMotionResult.CONTINUE;
            },
            acceptDrop: (source, a, x, y, time) =>
                this._hooks?.acceptDrop(source, a, x, y, time) ?? false,
        };
        // Draggable must connect before our press handler so DND sees presses first.
        makeWindowDraggable(actor, window, iconSize, { delegate, sourceIcon: true });

        actor.connect('notify::hover', () => this._onHoverChange());
        actor.connect('button-press-event', (a, event) => this._onButtonPressed(event));
        actor.connect('button-release-event', (a, event) => this._onButtonReleased(event));
        actor.connect('destroy', () => this._onDestroy());

        // Only these two need a full re-render (they change the icon's app
        // identity). Focus is handled in place below — toggling the style
        // class avoids destroying/recreating every icon on every focus change.
        this._renderSignals = ['notify::wm-class', 'notify::mapped']
            .map(sig => window.connect(sig, () => requestRender()));

        // Focus toggles the class directly; no rebuild. This is the
        // highest-frequency state change, so keeping it out of _render()
        // is a big win.
        this._focusSignalId = window.connect('notify::appears-focused', () => {
            if (window.appears_focused)
                actor.add_style_class_name('focused');
            else
                actor.remove_style_class_name('focused');
        });

        if (window.appears_focused)
            actor.add_style_class_name('focused');
    }

    setHooks(hooks) { this._hooks = hooks; }

    _setIcon(iconSize) {
        // Reuse a cached icon widget when possible. This skips the
        // WindowTracker app lookup + St.TextureCache round-trip on every
        // rebuild, which is one of the more expensive parts of _render().
        let iconActor = _getCachedIcon(this._window, iconSize);
        if (!iconActor) {
            iconActor = createWindowIconTexture(this._window, iconSize);
            _setCachedIcon(this._window, iconSize, iconActor);
        } else {
            // The cached widget may still be parented (e.g. it was removed
            // from a destroyed actor but not yet reparented here). Steal it
            // back so no two actors claim the same child.
            const parent = iconActor.get_parent();
            if (parent) parent.remove_child(iconActor);
        }

        this.actor.set_child(iconActor);

        // set_icon_geometry is only meaningful while the icon is on stage;
        // reconnect the one-shot geometry callback on each parenting.
        const id = iconActor.connect('stage-views-changed', () => {
            const rect = new Mtk.Rectangle();
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
        if (this._hoverTimeoutId) { GLib.Source.remove(this._hoverTimeoutId); this._hoverTimeoutId = 0; }
        if (intent.drag) return;
        if (this.actor.hover) {
            this._stopCleanup();
            if (this._isShowing()) { this.onCtrlChanged(ActivePreviewTracker._ctrlPressed); return; }
            // 30 ms debounce: don't flash a preview while the pointer passes through.
            this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
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
        this._cleanupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TimeoutDelay, () => {
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
        if (this._cleanupId) { GLib.Source.remove(this._cleanupId); this._cleanupId = 0; }
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
    // Press: only the right-click menu. A primary press must NOT touch
    // window state, or the resulting re-render destroys this icon mid-press
    // and the drag never starts.
    _onButtonPressed(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this.forceHidePreview();
            this._openMenu();
            return Clutter.EVENT_STOP;
        }
        // Swallow primary so the thumbnail behind us doesn't also handle it.
        return button === Clutter.BUTTON_PRIMARY ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    // Release: the actual click. After a real drag the release goes to
    // DND's grab, so this only runs for genuine clicks.
    _onButtonReleased(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

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
        });
        if (menu._boxPointer)
            menu._boxPointer.translation_y = -35;
    }

    // True if any visible window stacked above `window` overlaps it, even
    // partially. Dialogs attached to the window itself don't count.
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

    _onDestroy() {
        this.forceHidePreview();
        if (this._hoverTimeoutId) { GLib.Source.remove(this._hoverTimeoutId); this._hoverTimeoutId = 0; }
        for (const id of this._renderSignals) {
            try { this._window.disconnect(id); } catch (e) { /* window may be gone */ }
        }
        if (this._focusSignalId) {
            try { this._window.disconnect(this._focusSignalId); } catch (e) { /* window may be gone */ }
        }
        this._renderSignals = [];
        this._focusSignalId = 0;
        this._dragActivator.destroy();
        this._hooks = null;

        // The cached icon widget is about to be destroyed along with its
        // parent actor; evict it so the next render regenerates a fresh one
        // instead of parenting a dead widget.
        _evictIcon(this._window);
    }
}

// ==================== WORKSPACE INDICATOR ====================
// Immediate-mode: every state change schedules _render(), which destroys
// the whole UI and rebuilds it as a pure function of buildModel().
export class WorkspaceIndicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor(settings) {
        super(0.0, _('Workspace Indicator'));
        this.reactive = false;
        this._settings = settings;
        _instance = this;

        this._renderId = 0;
        this._renderDelay = 0;
        this._leavePollId = 0;
        this._nameHint = null;
        this._thumbsBox = null;
        this._settleActor = null;

        this._mainBox = new St.BoxLayout({
            style_class: 'workspace-indicator-main-box', y_expand: true, x_expand: true, reactive: true,
        });
        this.add_child(this._mainBox);

        // Only the intent path — the model owns every world/state signal.
        onIntentChange(() => this._queueRender());

        this._render();
    }

    // ---------- scheduling ----------
    _queueRender(delay = 0) {
        if (this._renderId) {
            if (delay >= this._renderDelay) return;
            GLib.Source.remove(this._renderId);
        }
        this._renderDelay = delay;
        const cb = () => { this._renderId = 0; this._render(); return GLib.SOURCE_REMOVE; };
        this._renderId = delay
            ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, cb)
            : GLib.idle_add(GLib.PRIORITY_DEFAULT, cb);
    }

    // ==================== THE RENDER ====================
    _render() {
        if (intent.menuOpen) return; // re-queued when the menu closes
        const model = buildModel();
        logModel(model);
        const s = this._settings;

        // The drag source icon must survive the rebuild — Shell DND holds it.
        const keep = model.drag?.sourceIcon ?? null;
        keep?.get_parent()?.remove_child(keep);
        this._mainBox.destroy_all_children();
        this._settleActor = null;

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
            this._thumbsBox.add_child(this._buildThumbnail(entry, model, keep));
        this._mainBox.add_child(this._thumbsBox);

        if (keep && !keep.get_parent()) keep.destroy(); // its window left; nothing to keep alive
        if (this._settleActor) settleIcon(this._settleActor);
        this._syncHint(model);
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

    _buildThumbnail(entry, model, keep) {
        const { workspace, index, windows } = entry;
        const s = this._settings;
        const drag = model.drag;

        const thumb = new St.Button({ style_class: 'workspace-thumbnail', x_expand: true, y_expand: true });
        thumb.set_style(`min-width: ${s.get_int('thumbnail-min-width')}px;`);
        if (index === WorkspaceManager.get_active_workspace_index())
            thumb.add_style_class_name('active');
        thumb._wsEntry = { workspace, index };

        const box = new St.BoxLayout();
        thumb.set_child(box);
        const direct = windows.length <= DIRECT_MODE_MAX_WINDOWS;

        const hooks = {
            handleDragOver: (source) => {
                try {
                    return this._handleDragOver(box, entry, direct, source);
                } catch (e) {
                    journal(`[handleDragOver] THREW: ${e.message}\n${e.stack}`, true);
                    return DragMotionResult.MOVE_DROP;
                }
            },
            acceptDrop: (source, actor) => {
                try {
                    return this._acceptDrop(thumb, box, entry, direct, source, actor);
                } catch (e) {
                    journal(`[acceptDrop] THREW: ${e.message}\n${e.stack}`, true);
                    setIntent({ drag: null });
                    return false;
                }
            },
        };
        thumb._delegate = hooks;

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

        // Direct mode: icons, plus the drag ghost if it targets this workspace.
        const ghostAt = drag?.target?.wsIndex === index ? drag.target.index : null;
        let n = 0, ghostPlaced = false;
        const placeGhost = () => {
            box.add_child(createGhostIcon(getWindowAppIcon(drag.window), s.get_int('icon-size')));
            ghostPlaced = true;
        };

        const windowsFromModel = windows.concat(); // model-provided, already ordered
        for (const w of windowsFromModel) {
            if (w !== drag?.window) {
                if (ghostAt === n) placeGhost();
                n++;
            }
            const actor = (keep && keep._window === w) ? keep : new WindowIcon(w, s).actor;
            actor._icon.setHooks(hooks);
            // Experiment: keep the source in the layout, dimmed, rather than
            // hiding it. The ghost marks the drop target next to it.
            if (actor === keep) actor.opacity = 80;
            box.add_child(actor);
            if (w === _settleWindow) { _settleWindow = null; this._settleActor = actor; }
        }
        if (ghostAt !== null && !ghostPlaced) placeGhost();
        return thumb;
    }

    _syncHint(model) {
        const s = this._settings;
        const target = model.hintWs !== null ? this._thumbsBox?.get_child_at_index(model.hintWs) : null;
        if (!target || !s.get_boolean('show-workspace-names')) {
            this._nameHint?.hide();
            return;
        }
        if (!this._nameHint)
            this._nameHint = new FloatingTooltip({ fontSize: s.get_int('tooltip-font-size') });
        this._nameHint.showAbove(target, Meta.prefs_get_workspace_name(model.hintWs));
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
    // The thumbnail is the sole classifier. `source` is the draggable's
    // _delegate (NOT the actor):
    //   source._window set   → reorder / move a window (sets drag.target)
    //   source._window unset → external drag (files, text): switch workspace on hover
    _handleDragOver(box, entry, direct, source) {
        this._ensureLeavePoll();
        setIntent({ hintWs: entry.index });

        if (!source?._window) {
            if (entry.workspace !== WorkspaceManager.get_active_workspace())
                entry.workspace.activate(global.get_current_time());
            return DragMotionResult.MOVE_DROP;
        }

        if (direct) {
            const [pointerX] = global.get_pointer();
            setDragTarget({ wsIndex: entry.index, index: this._insertionIndex(box, pointerX) });
        } else {
            setDragTarget(null); // collection mode isn't a reorder target
        }
        return DragMotionResult.MOVE_DROP;
    }

    _acceptDrop(thumb, box, entry, direct, source, actor) {
        setIntent({ hintWs: null });
        const win = source?._window ?? null;
        if (!win) return true; // external: workspace already switched on hover

        const [pointerX] = global.get_pointer();
        const index = direct ? this._insertionIndex(box, pointerX) : null; // null → end
        const sameWs = win.get_workspace() === entry.workspace;

        // Synthetic drag actor (not the real source icon): ours to discard.
        if (actor && actor !== source._actor) {
            actor.get_parent()?.remove_child(actor);
            try { actor.destroy(); } catch (e) { /* ignore */ }
        }

        if (sameWs && !direct) { setIntent({ drag: null }); return true; }

        placeWindow(win, entry.workspace, index);
        if (!sameWs) {
            const monitorIndex = Main.layoutManager.findIndexForActor(thumb);
            if (monitorIndex !== win.get_monitor()) win.move_to_monitor(monitorIndex);
            win.change_workspace(entry.workspace);
        }
        _settleWindow = win;
        setIntent({ drag: null });
        return true;
    }

    // Insertion index among the visible icons (excluding the dragged one),
    // measured in "ghost-free" coordinates: icons after the ghost are
    // shifted back by the ghost's slot width so the ghost can't make the
    // result flip-flop.
    _insertionIndex(box, pointerX) {
        const kids = box.get_children();
        const ghostPos = kids.findIndex(k => k._isGhost);
        let shift = 0;
        if (ghostPos >= 0) {
            const next = kids.slice(ghostPos + 1).find(k => k.visible);
            if (next)
                shift = next.get_transformed_position()[0] - kids[ghostPos].get_transformed_position()[0];
        }
        const dragged = intent.drag?.window;
        const rects = [];
        kids.forEach((k, i) => {
            if (!k._window || !k.visible || k._window === dragged) return;
            let [x] = k.get_transformed_position();
            const [w] = k.get_transformed_size();
            if (ghostPos >= 0 && i > ghostPos) x -= shift;
            rects.push({ item: k, x, width: w, mid: x + w / 2, right: x + w });
        });
        return computeInsertion(rects, pointerX).index;
    }

    // The Shell has no per-actor "drag left" signal and grabs suppress
    // enter/leave, so poll while a drag hovers us: when the button is
    // released or the pointer leaves every thumbnail, clear hint + ghost.
    _ensureLeavePoll() {
        if (this._leavePollId) return;
        this._leavePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const [px, py, mods] = global.get_pointer();
            const held = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
            if (!held || !this._thumbnailAt(px, py)) {
                this._leavePollId = 0;
                setIntent({ hintWs: null });
                setDragTarget(null);
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
    cleanupSources() {
        if (this._renderId) { GLib.Source.remove(this._renderId); this._renderId = 0; }
        if (this._leavePollId) { GLib.Source.remove(this._leavePollId); this._leavePollId = 0; }
    }

    destroy() {
        this.cleanupSources();
        onIntentChange(null);
        resetIntent();
        _instance = null;

        this._nameHint?.destroy();
        this._nameHint = null;
        this._mainBox?.destroy();
        Main.panel.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        super.destroy();
    }
}