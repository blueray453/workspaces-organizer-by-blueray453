// ===== FILE: ./lib/interactions.js =====
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import * as Scheduling from './scheduling.js';
import * as Model from './model.js';
import * as UI from './ui.js';
import * as WorkspaceActions from './workspaceActions.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

export const DragMotionResult = DND.DragMotionResult;

// ==================== animations ====================
export function fadeInActor(actor, duration = Model.FadeInDuration, mode = Clutter.AnimationMode.EASE_OUT_QUAD) {
    if (!actor) { journal('[fadeInActor] called with null actor'); return; }
    try {
        if (!actor.get_stage()) { journal('[fadeInActor] actor not on stage, skipping'); return; }
        actor.remove_all_transitions();
        if (duration === 0) { actor.opacity = 255; return; }
        actor.opacity = 0;
        actor.ease({ opacity: 255, duration, mode });
    } catch (e) {
        journal(`[fadeInActor] error: ${e}`);
    }
}

export function settleIcon(actor, duration = Model.SettleAnimationDuration, mode = Clutter.AnimationMode.EASE_OUT_QUAD) {
    if (!actor) { journal('[settleIcon] called with null actor'); return; }
    try {
        if (!actor.get_stage()) { journal('[settleIcon] actor not on stage, skipping'); return; }
        actor.remove_all_transitions();
        actor.set_pivot_point(0.5, 0.5);
        if (duration === 0) {
            actor.set_scale(1, 1);
            actor.opacity = 255;
            return;
        }
        actor.set_scale(0.85, 0.85);
        actor.opacity = 160;
        actor.ease({ scale_x: 1, scale_y: 1, opacity: 255, duration, mode });
    } catch (e) {
        journal(`[settleIcon] error: ${e}`);
    }
}

// ==================== shared tooltip ====================
function createTooltip() {
    const label = new St.Label({
        style_class: 'topnotch-tooltip',
        visible: false,
        reactive: true,
        track_hover: true,
    });
    Main.layoutManager.addChrome(label);

    function apply(text, fontSize) {
        if (fontSize != null) label.set_style(`font-size: ${fontSize}pt;`);
        label.set_text(text);
        label.show();
        try { Main.layoutManager.uiGroup.set_child_above_sibling(label, null); }
        catch (e) { /* nothing else in uiGroup yet */ }
    }

    function show(actor, text, fontSize, prefer) {
        apply(text, fontSize);

        const [width, height] = label.get_size();
        const [actorX, actorY] = actor.get_transformed_position();
        const actorWidth = actor.get_width();
        const actorHeight = actor.get_height();

        const monitorIndex = Main.layoutManager.findIndexForActor(actor);
        const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;
        const pad = 6;

        const minX = monitor.x + pad;
        const maxX = monitor.x + monitor.width - width - pad;
        const minY = monitor.y + pad;
        const maxY = monitor.y + monitor.height - height - pad;

        let x = Math.round(actorX + (actorWidth - width) / 2);
        x = Math.max(minX, Math.min(x, maxX));

        const above = Math.round(actorY - height - 8);
        const below = Math.round(actorY + actorHeight + 8);
        let y;
        if (prefer === 'below') { y = below; if (y > maxY) y = above; }
        else { y = above; if (y < minY) y = below; }
        y = Math.max(minY, Math.min(y, maxY));

        label.set_position(x, y);
    }

    return {
        get hover() { return label.hover; },

        showAbove(actor, text, fontSize = null) { show(actor, text, fontSize, 'above'); },
        showBelow(actor, text, fontSize = null) { show(actor, text, fontSize, 'below'); },

        showCentered(actor, text, y, fontSize = null, padding = 10) {
            apply(text, fontSize);
            const width = label.width;
            const [actorX] = actor.get_transformed_position();
            let x = actorX + (actor.get_width() - width) / 2;
            x = Math.max(padding, Math.min(x, Model.screenWidth - width - padding));
            label.set_position(Math.round(x), Math.round(y));
        },

        hide() { label.hide(); },

        destroy() {
            Main.layoutManager.removeChrome(label);
            label.destroy();
        },
    };
}

let _sharedTooltip = null;

export function getTooltip() {
    if (!_sharedTooltip) _sharedTooltip = createTooltip();
    return _sharedTooltip;
}

export function destroyTooltip() {
    _sharedTooltip?.destroy();
    _sharedTooltip = null;
}

// ==================== reorder ghost ====================
export function createReorderGhost({ iconSize, giconFor = s => s._dragPayload?.gicon }) {
    let container = null;
    let source = null;
    let ghost = null;
    let ghostIndex = null;
    let snap = null;

    function takeSnapshot() {
        const src = source._actor ?? source;
        return container.get_children()
            .filter(b => b !== src && b._dragItem && b.get_stage())
            .map(b => {
                const [x] = b.get_transformed_position();
                const [w] = b.get_transformed_size();
                return { item: b, x, width: w, mid: x + w / 2, right: x + w };
            });
    }

    function place(insertion) {
        if (ghostIndex === insertion.index && ghost?.get_parent()) return;

        if (!ghost)
            ghost = UI.createGhostIcon(giconFor(source), iconSize());

        ghost.get_parent()?.remove_child(ghost);

        const { neighbor, insertBefore } = insertion;
        if (!neighbor) container.add_child(ghost);
        else if (insertBefore) container.insert_child_below(ghost, neighbor);
        else container.insert_child_above(ghost, neighbor);

        ghostIndex = insertion.index;
    }

    function begin(newContainer, newSource) {
        if (container !== newContainer) {
            ghost?.get_parent()?.remove_child(ghost);
            ghostIndex = null;
            snap = null;
        }
        container = newContainer;
        if (source !== newSource) { source = newSource; snap = null; }
    }

    function update(pointerX) {
        if (!container || !source) return null;
        if (!snap) snap = takeSnapshot();
        const insertion = UI.computeInsertion(snap, pointerX);
        place(insertion);
        return insertion;
    }

    function clear() {
        const g = ghost;
        ghost = null;
        ghostIndex = null;
        snap = null;
        container = null;
        source = null;
        if (!g) return;
        try { g.get_parent()?.remove_child(g); g.destroy(); }
        catch (e) { /* already gone */ }
    }

    return {
        get index() { return ghostIndex; },
        begin, update, clear,
    };
}

// ==================== draggable ====================
export function makeDraggable(actor, {
    iconSize, payload, gicon, delegate = {}, onDragBegin = null, onDragEnd = null,
}) {
    actor._dragItem = true;
    actor._dragPayload = payload;
    actor._delegate = Object.assign(delegate, {
        _dragPayload: payload,
        _actor: actor,
        getDragActorSource: () => actor,
        getDragActor: () => UI.createDragActor(gicon ?? payload?.gicon, iconSize),
    });

    const draggable = DND.makeDraggable(actor, {
        restoreOnSuccess: false,
        dragActorMaxSize: iconSize,
        dragActorOpacity: 178,
    });
    draggable.connect('drag-begin', () => { actor.opacity = 80; onDragBegin?.(); });
    draggable.connect('drag-end', () => {
        try { actor.opacity = 255; } catch (e) { /* source may be gone */ }
        onDragEnd?.();
    });
    return draggable;
}

// ==================== drop strip ====================
export function createDropStrip({
    container, ghost, acceptSource,
    externalResult = DragMotionResult.MOVE_DROP,
    onDragOver = null, onExternalDragOver = null, onDrop,
    hint = null, hintText = null,
}) {
    function handleDragOver(src) {
        onDragOver?.(src);

        if (!acceptSource(src)) {
            cancel();
            onExternalDragOver?.(src);
            return externalResult;
        }

        const [pointerX] = global.get_pointer();
        ghost.begin(container, src);
        const insertion = ghost.update(pointerX);
        if (insertion && hint && hintText)
            hint.show(insertion.neighbor ?? container, hintText(insertion));
        return DragMotionResult.MOVE_DROP;
    }

    function acceptDrop(src, actor) {
        const accepted = acceptSource(src);
        const index = accepted ? ghost.index : null;
        cancel();
        return onDrop(src, index, actor);
    }

    function cancel() {
        ghost.clear();
        hint?.hide();
    }

    function delegate() {
        return {
            handleDragOver: s => handleDragOver(s),
            acceptDrop: (s, a) => acceptDrop(s, a),
        };
    }

    return { handleDragOver, acceptDrop, delegate, cancel };
}

// ==================== context menu ====================
let _activeMenu = null;

export function openContextMenu(anchor, populate, { translationY = 0 } = {}) {
    _activeMenu?.close();
    const menu = new PopupMenu.PopupMenu(anchor, 0.0, St.Side.TOP);
    const manager = new PopupMenu.PopupMenuManager(anchor);
    manager.addMenu(menu);
    Main.uiGroup.add_child(menu.actor);
    populate(menu);

    _activeMenu = menu;
    menu.connect('open-state-changed', (m, isOpen) => {
        if (isOpen) return;
        if (_activeMenu === menu) _activeMenu = null;
        Model.setIntent({ menuOpen: false });
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try { manager.destroy(); } catch (e) { /* already gone */ }
            menu.destroy();
            return GLib.SOURCE_REMOVE;
        });
    });
    Model.setIntent({ menuOpen: true });
    menu.open(true);
    if (menu._boxPointer && translationY) menu._boxPointer.translation_y = translationY;
    return menu;
}

// ==================== active hover ====================
const ActiveHover = (() => {
    let current = null;
    let ctrlPressed = false;
    let pollId = 0;

    function readCtrl() {
        const [, , mods] = global.get_pointer();
        return (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
    }

    function stopPoll() {
        if (pollId) { GLib.Source.remove(pollId); pollId = 0; }
    }

    function startPoll() {
        if (pollId) return;
        ctrlPressed = readCtrl();
        pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Model.TimeoutDelay, () => {
            if (!current) { pollId = 0; return GLib.SOURCE_REMOVE; }
            const ctrl = readCtrl();
            if (ctrl !== ctrlPressed) {
                ctrlPressed = ctrl;
                current.onCtrlChanged(ctrl);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    return {
        get current() { return current; },
        get ctrlPressed() { return ctrlPressed; },
        activate(controller) {
            if (current && current !== controller) current.forceHide();
            current = controller;
            startPoll();
        },
        deactivate(controller) {
            if (current === controller) { current = null; stopPoll(); }
        },
    };
})();

// ==================== external drag auto-activate ====================
// Fires 400 ms after the first notify(); aborts if the pointer has left
// the icon in the meantime. The pointer is polled every 40 ms, so 120 ms
// is a fresh-enough threshold to cancel a sweep across icons.
const EXT_HOVER_FRESH_MS = 120;

function createExternalDragAutoActivate(window) {
    const scope = new Scheduling.Scope();
    let id = 0;
    let lastHover = 0;

    function notify() {
        lastHover = GLib.get_monotonic_time();
        if (id) return;
        id = scope.timeout(400, () => {
            id = 0;
            if ((GLib.get_monotonic_time() - lastHover) / 1000 > EXT_HOVER_FRESH_MS)
                return GLib.SOURCE_REMOVE;
            WorkspaceActions.focusWindow(window);
            return GLib.SOURCE_REMOVE;
        });
    }

    function destroy() { scope.dispose(); }

    return { notify, destroy };
}

// ==================== window icon controller ====================
export class WindowIconController {
    static DEBOUNCE = 30;

    constructor({ window, actor, icon, settings, strip, onRequestRender,
        onHoverFlyout, onHoverExit }) {
        this.window = window;
        this.actor = actor;

        this._settings = settings;
        this._strip = strip;
        this._onRequestRender = onRequestRender;
        this._onHoverFlyout = onHoverFlyout;
        this._onHoverExit = onHoverExit;
        this._scope = new Scheduling.Scope();
        this._external = createExternalDragAutoActivate(window);

        this._preview = null;
        this._previewScope = null;
        this._hoverId = 0;
        this._cleanupId = 0;

        const iconSize = settings.get_int('icon-size');

        this._scope.connect(icon, 'stage-views-changed', () => {
            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = icon.get_transformed_position();
            [rect.width, rect.height] = icon.get_transformed_size();
            window.set_icon_geometry(rect);
        });

        this._scope.connect(window, 'notify::wm-class', onRequestRender);
        this._scope.connect(window, 'notify::mapped', onRequestRender);
        this._scope.connect(window, 'notify::appears-focused', () => this._syncFocus());

        makeDraggable(actor, {
            iconSize,
            payload: { kind: 'window', window, gicon: UI.getWindowAppIcon(window) },
            delegate: {
                handleDragOver: (source) => {
                    if (source === actor._delegate) return DragMotionResult.CONTINUE;
                    if (!source?._dragPayload?.window) this._external.notify();
                    return this._strip?.handleDragOver(source) ?? DragMotionResult.CONTINUE;
                },
                acceptDrop: (source, dragActor) =>
                    this._strip?.acceptDrop(source, dragActor) ?? false,
            },
            onDragBegin: () => Model.setIntent({ drag: true }),
            onDragEnd: () => Model.setIntent({ drag: null, hintWs: null }),
        });

        this._scope.connect(actor, 'notify::hover', () => this._onHover());
        this._scope.connect(actor, 'button-press-event', (a, e) => this._onPressed(e));
        this._scope.connect(actor, 'button-release-event', (a, e) => this._onReleased(e));

        this._syncFocus();
    }

    setStrip(strip) { this._strip = strip; }

    notifyExternalDrag() { this._external.notify(); }

    destroy() {
        this.forceHide();
        this._external.destroy();
        this._scope.dispose();
        this._strip = null;
        this._onRequestRender = null;
        this._onHoverFlyout = null;
        this._onHoverExit = null;
        try { this.actor?.destroy(); } catch (e) { /* already gone */ }
    }

    _onHover() {
        if (this._hoverId) { this._scope.cancel(this._hoverId); this._hoverId = 0; }
        if (this.actor.hover) {
            this._cancelCleanup();
            if (this._preview) return;
            this._hoverId = this._scope.timeout(WindowIconController.DEBOUNCE, () => {
                this._hoverId = 0;
                if (!this.actor.hover && !this._preview) return GLib.SOURCE_REMOVE;
                ActiveHover.activate(this);
                this._render();
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._preview) {
            this._startCleanup();
        }
    }

    onCtrlChanged(ctrl) {
        // ActiveHover.current is set on the last-hovered controller and
        // stays set until some other icon activates or a preview cleanup
        // fires. Without this gate, pressing Ctrl after a prior hover
        // (with the pointer now elsewhere) pops a clone out of nowhere.
        // Only react to Ctrl changes while the pointer is on the icon or
        // over the icon's own clone preview.
        if (!this.actor.hover && !this._preview) return;
        this._render(ctrl);
    }

    forceHide() {
        if (this._hoverId) { this._scope.cancel(this._hoverId); this._hoverId = 0; }
        this._cancelCleanup();
        this._hide();
        ActiveHover.deactivate(this);
    }

    _render(ctrl = ActiveHover.ctrlPressed) {
        if (ctrl) {
            // Ctrl held: clone preview replaces the flyout.
            this._hideFlyout();
            this._showPreview();
        } else {
            // No modifier: list of windows on this workspace.
            this._hidePreview();
            this._showFlyout();
        }
    }

    _showFlyout() {
        if (!this._onHoverFlyout) return;
        const ws = this.window.get_workspace();
        const wsIndex = ws ? ws.index()
            : Model.WorkspaceManager.get_active_workspace_index();
        // CHANGED: also pass the window so the flyout can highlight its row.
        this._onHoverFlyout(this.actor, wsIndex, this.window);
    }

    _hideFlyout() { this._onHoverExit?.(); }

    _onPreviewHover(isHovered) {
        if (isHovered) this._cancelCleanup();
        else if (!this.actor.hover) this._startCleanup();
    }

    _startCleanup() {
        this._cancelCleanup();
        this._cleanupId = this._scope.timeout(Model.TimeoutDelay, () => {
            this._cleanupId = 0;
            if (this.actor.hover || this._preview?.hover)
                return GLib.SOURCE_REMOVE;
            this._hide();
            ActiveHover.deactivate(this);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelCleanup() {
        if (this._cleanupId) { this._scope.cancel(this._cleanupId); this._cleanupId = 0; }
    }

    _hide() {
        this._hidePreview();
        this._hideFlyout();
    }

    _showPreview() {
        if (this._preview) return;
        const win = this.window;
        const previewHeight = this._settings.get_int('hover-preview-height');
        const built = UI.createClonePreview(win, previewHeight, {
            wrapperStyleClass: 'hover-preview-wrapper',
            showTitle: false,
            closeButtonSize: this._settings.get_int('close-button-size'),
            closeButtonOffsetX: 60,
            closeButtonOffsetY: 10,
        });
        if (!built) return;

        this._previewScope = new Scheduling.Scope();

        if (built.wrapper)
            this._previewScope.connect(built.wrapper, 'notify::hover',
                () => this._onPreviewHover(built.wrapper.hover));
        if (built.wrapper)
            this._previewScope.connect(built.wrapper, 'button-press-event', (a, e) => {
                if (e.get_button() === Clutter.BUTTON_PRIMARY) {
                    win.get_workspace().activate_with_focus(win, 0);
                    this._hide();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        if (built.closeButton)
            this._previewScope.connect(built.closeButton, 'clicked', () => {
                win.delete(global.get_current_time());
                this._hide();
                return Clutter.EVENT_STOP;
            });

        const [anchorX] = this.actor.get_transformed_position();
        const monitorIndex = Main.layoutManager.findIndexForActor(this.actor);
        const monitor = Main.layoutManager.monitors[monitorIndex]
            ?? Main.layoutManager.primaryMonitor;
        const x = Math.max(monitor.x,
            anchorX + (this.actor.get_width() - built.width) / 2);
        const clampedX = Math.min(x, monitor.x + monitor.width - built.width);
        const y = monitor.y + monitor.height - built.height - 200 + 55;
        built.actor.set_position(Math.round(clampedX), Math.round(y));

        this._preview = built.actor;
        Main.layoutManager.addChrome(this._preview);
        fadeInActor(this._preview);
    }

    _hidePreview() {
        if (!this._preview) return;
        this._previewScope?.dispose();
        this._previewScope = null;
        const actor = this._preview;
        this._preview = null;
        Main.layoutManager.removeChrome(actor);
        actor.destroy();
    }

    _syncFocus() {
        const on = !!this.window.appears_focused;
        if (on) this.actor.add_style_class_name('focused');
        else this.actor.remove_style_class_name('focused');
        this.actor.set_pivot_point(0.5, 0.5);
        this.actor.set_scale(on ? 1.06 : 1, on ? 1.06 : 1);
    }

    _onPressed(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this.forceHide();
            this._openMenu();
            return Clutter.EVENT_STOP;
        }
        return button === Clutter.BUTTON_PRIMARY ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _onReleased(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;

        this.forceHide();
        const win = this.window;
        const winWs = win.get_workspace();
        if (winWs === Model.WorkspaceManager.get_active_workspace()) {
            if (win.minimized) { WorkspaceActions.focusWindow(win); }
            else if (!win.appears_focused || this._isCovered(win)) win.activate_with_workspace(0, winWs);
            else win.minimize();
        } else {
            winWs.activate_with_focus(win, 0);
        }
        return Clutter.EVENT_STOP;
    }

    _openMenu() {
        const win = this.window;
        openContextMenu(this.actor, m => {
            m.addAction(`Activate ${win.title}`, () => win.get_workspace().activate_with_focus(win, 0));
            m.addAction(`Close ${win.title}`, () => win.delete(0));
            m.addAction(`Close Except ${win.title}`, () => {
                const wmClass = win.get_wm_class();
                const others = Model.getModelWindows(win.get_workspace())
                    .filter(w => w !== win && w.get_wm_class() === wmClass
                        && w.get_wm_class_instance() !== 'file_progress');
                const now = global.get_current_time();
                for (const w of others) w.delete(now);
            });

            const app = UI.getWindowApp(win);
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
            if (actions?.length) {
                m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                for (const action of actions)
                    m.addAction(`${appInfo.get_action_name(action)}`, () => app.launch_action(action, 0, -1));
            }
        }, { translationY: -35 });
    }

    _isCovered(window) {
        if (window.minimized) return false;
        const workspace = Model.WorkspaceManager.get_active_workspace();
        const stacked = Model.Display.sort_windows_by_stacking(
            Model.getModelWindows(workspace).filter(w => !w.minimized));

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
}