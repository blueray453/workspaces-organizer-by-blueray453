// ===== FILE: ./lib/workspaceIndicator.js =====
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as ExtensionModule from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import * as Model from './model.js';
import * as Scheduling from './scheduling.js';
import * as Interactions from './interactions.js';
import * as UI from './ui.js';
import * as WorkspaceActions from './workspaceActions.js';
import * as Motion from './motion.js';
import { S, REL } from './sizes.js';
import { Dwell, Poller } from './util.js';
import { GroupFlyout } from './flyout.js';
import { externalDrag, buttonHeld } from './externalDrag.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const _ = ExtensionModule.gettext;

let _instance = null;
let _settleWindow = null;

const MIN_RENDER_INTERVAL_MS = 100;
const EXT_TICK_MS = 40;
const EXT_PREVIEW_MS = 150;
const SLACK_PX = 32;
const MAX_SOLVE_STEPS = 6;

const fmtNum = v => Number.isFinite(v) ? String(Math.round(v)) : 'NaN';

export function thumbnailAt(x, y) { return _instance?._thumbnailAt(x, y) ?? null; }
export function settleOnNextRender(window) { _settleWindow = window; }

export function toggleGroupFlyout(workspaceIndex, wmClass = '') {
    return _instance?._toggleGroupFlyout(workspaceIndex, wmClass) ?? false;
}

export function closeGroupFlyout() {
    return _instance?._closeGroupFlyout() ?? false;
}

export class WorkspaceIndicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor(settings, commands) {
        super(0.0, _('Workspace Indicator'), true);
        this.reactive = false;
        this._settings = settings;
        this._commands = commands;
        _instance = this;

        this._focusRelease = null;

        this._controllers = new Map();
        this._lastIconSize = undefined;
        this._lastRenderTime = undefined;
        this._toolbarKey = null;
        this._staticBox = null;
        this._nameLabel = null;
        this._thumbsBox = null;
        this._entries = [];

        this._collapsed = new Set();
        this._denseStep = 0;

        this._scope = new Scheduling.Scope();
        this._renderCoalescer = new Scheduling.Coalescer(() => this._render());
        this._leavePollId = 0;

        this._groupDwell = new Dwell(this._scope,
            () => settings.get_int('flyout-dwell-ms'),
            { rearmAfterFire: true });
        this._extRowDwell = new Dwell(this._scope, EXT_PREVIEW_MS);
        this._extWsDwell = new Dwell(this._scope,
            () => settings.get_int('ext-ws-dwell-ms'));
        this._extPoll = new Poller(this._scope, {
            interval: EXT_TICK_MS,
            name: 'ext',
            tick: () => this._externalTickInner(),
        });

        this._groupIcons = new Map();

        this._flyout = new GroupFlyout(settings);

        this._extSawButton = false;
        this._extGroupKey = null;
        this._geoRelogId = 0;

        this._stickyRequest = null;

        this._lastHintWs = Model.intent.hintWs;
        this._lastDragActive = !!Model.intent.drag;
        this._lastMenuOpen = !!Model.intent.menuOpen;

        this._ghost = Interactions.createReorderGhost({
            iconSize: () => S.indicator.windowIcon,
        });

        this._mainBox = new St.BoxLayout({
            style_class: 'workspace-indicator-main-box',
            y_expand: true, x_expand: true, reactive: true,
        });
        this.add_child(this._mainBox);

        this._unsubIntent = Model.intentStore.changed.on(() => this._onIntentChanged());
        this._unsubWorld = Model.world.on(() => this._queueRender());

        this._extUnsub = externalDrag.onChanged(state => this._onExternalChanged(state));

        this._render();
    }

    _dragActive() { return !!Model.intent.drag || externalDrag.active; }

    _onIntentChanged() {
        const hintChanged = Model.intent.hintWs !== this._lastHintWs;
        const isDragging = !!Model.intent.drag;
        const isMenu = !!Model.intent.menuOpen;
        const dragChanged = isDragging !== this._lastDragActive;
        const menuChanged = isMenu !== this._lastMenuOpen;

        this._lastHintWs = Model.intent.hintWs;
        this._lastDragActive = isDragging;
        this._lastMenuOpen = isMenu;

        if (dragChanged && isDragging) {
            Interactions.getTooltip().hide();
            if (this._flyout.isOpen) {
                this._cancelDwell();
                this._flyout.close(true);
            }
        }
        if (!this._dragActive() && !this._flyout.sticky) {
            this._cancelDwell();
            this._flyout.close(true);
        }
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

    _render() {
        if (Model.intent.menuOpen) return;
        if (Model.intent.drag) return;
        if (externalDrag.active) return;

        const hadFlyout = this._flyout.isOpen;
        const keepKey = hadFlyout ? this._flyout.anchorKey : null;
        if (hadFlyout && !keepKey) {
            journal('[flyout] re-render -> closing unkeyed flyout');
            this._flyout.close(true);
        }

        this._ghost.clear();

        const model = Model.buildModel();
        const s = this._settings;

        const iconSize = S.indicator.windowIcon;
        if (this._lastIconSize !== undefined && this._lastIconSize !== iconSize) {
            for (const ctrl of this._controllers.values()) ctrl.destroy();
            this._controllers.clear();
        }
        this._lastIconSize = iconSize;

        for (const ctrl of this._controllers.values()) {
            const parent = ctrl.actor.get_parent();
            if (parent) parent.remove_child(ctrl.actor);
        }

        const toolbarKey = [
            s.get_boolean('show-window-button'),
            s.get_boolean('show-workspace-names'),
            S.indicator.toolbarIcon,
            S.indicator.workspaceName,
        ].join('|');
        if (this._toolbarKey !== toolbarKey) {
            this._toolbarKey = toolbarKey;
            this._buildToolbar(s);
        }
        if (this._nameLabel) {
            this._nameLabel.set_text(Meta.prefs_get_workspace_name(
                Model.WorkspaceManager.get_active_workspace_index()));
        }

        this._thumbsBox?.destroy();
        this._settleActor = null;
        this._entries = [];
        this._groupIcons.clear();

        this._thumbsBox = new St.BoxLayout({
            style_class: 'workspace-indicator-class',
            y_expand: true, reactive: true,
            clip_to_allocation: true,
        });
        this._mainBox.add_child(this._thumbsBox);

        const seen = new Set();
        for (const entry of model.workspaces) {
            this._entries.push(this._buildThumbShell(entry));
            this._thumbsBox.add_child(this._entries[this._entries.length - 1].actor);
        }
        for (const entry of model.workspaces)
            for (const w of entry.windows) seen.add(`${w.get_id()}:${entry.index}`);

        this._solveGrouping(model);

        for (const [key, ctrl] of this._controllers) {
            if (!seen.has(key)) {
                ctrl.destroy();
                this._controllers.delete(key);
            }
        }

        if (keepKey && this._flyout.isOpen) {
            const anchor = this._anchorForKey(keepKey);
            if (anchor) {
                this._flyout.retarget(anchor);
            } else {
                journal(`[flyout] re-render -> anchor for ${keepKey} gone, closing`);
                this._flyout.close(true);
            }
        }

        if (this._settleActor) Motion.settle(this._settleActor);
        this._syncHint();

        this._lastRenderTime = GLib.get_monotonic_time() / 1000;
    }

    _buildToolbar(s) {
        if (!this._staticBox) {
            this._staticBox = new St.BoxLayout({
                y_expand: true, y_align: Clutter.ActorAlign.CENTER,
            });
            this._mainBox.insert_child_at_index(this._staticBox, 0);
        }
        this._staticBox.destroy_all_children();
        this._nameLabel = null;

        const iconSize = S.indicator.toolbarIcon;
        if (s.get_boolean('show-window-button')) {
            const b = UI.createToolbarButton('focus-windows-symbolic', iconSize, 'All windows');
            b.connect('clicked', () => this._commands.showAllWindows());
            this._staticBox.add_child(b);
        }
        if (s.get_boolean('show-workspace-names')) {
            this._nameLabel = UI.createWorkspaceNameLabel(
                Meta.prefs_get_workspace_name(Model.WorkspaceManager.get_active_workspace_index()),
                S.indicator.workspaceName);
            this._staticBox.add_child(this._nameLabel);
        }
    }

    _buildThumbShell(entry) {
        const s = this._settings;

        const { actor: thumb, box } = UI.createThumbnail({
            minWidth: s.get_int('thumbnail-min-width'),
            active: entry.index === Model.WorkspaceManager.get_active_workspace_index(),
        });
        thumb._wsEntry = { workspace: entry.workspace, index: entry.index };

        const content = new St.BoxLayout({
            style_class: 'ws-contents',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(content);

        const shell = { entry, actor: thumb, content, strip: null };

        const strip = Interactions.createDropStrip({
            container: content,
            ghost: this._ghost,
            acceptSource: source => source?._dragPayload?.kind === 'window',
            externalResult: Interactions.DragMotionResult.MOVE_DROP,
            onDragOver: () => {
                this._ensureLeavePoll();
                Model.setIntent({ hintWs: entry.index });
            },
            onExternalDragOver: () => {
                if (externalDrag.active) return;
                if (entry.workspace !== Model.WorkspaceManager.get_active_workspace())
                    entry.workspace.activate(global.get_current_time());
            },
            onDrop: (source, dropIndex, dragActor, insertion) => {
                this._cancelDwell();
                this._flyout.close(true);
                return this._dropOnWorkspace(thumb, entry, source,
                    this._resolveDrop(insertion), dragActor);
            },
        });
        shell.strip = strip;
        thumb._delegate = strip.delegate();

        thumb.connect('button-press-event', (actor, event) => {
            const b = event.get_button();
            if (b === Clutter.BUTTON_PRIMARY) entry.workspace.activate(0);
            else if (b === Clutter.BUTTON_SECONDARY) this._openThumbnailMenu(thumb, entry.workspace);
            return Clutter.EVENT_STOP;
        });

        return shell;
    }

    _isCollapsed(group) {
        if (group.count < 2) return false;
        if (this._settings.get_boolean('group-apps-always')) return true;
        return this._collapsed.has(group.key);
    }

    _isGrouped(entry) {
        return entry.groups.some(g => this._isCollapsed(g));
    }

    _iconSize() {
        const base = S.indicator.windowIcon;
        const dense = this._entries.some(e => this._isGrouped(e.entry));
        if (!dense) return base;
        const rung = Math.min(this._denseStep, REL.denseLadder.length - 1);
        return Math.max(S.indicator.denseFloor, Math.round(base * REL.denseLadder[rung]));
    }

    _widthBudget() {
        const panelW = Main.panel.width > 0
            ? Main.panel.width
            : Main.layoutManager.primaryMonitor.width;
        const [x] = this.get_transformed_position();
        const left = Number.isFinite(x) ? Math.max(0, x) : 0;

        let reserve = 28;
        const rb = Main.panel._rightBox;
        if (rb && rb.width > 0) reserve += rb.width + 12;
        else reserve += Math.round(panelW * 0.30);

        return Math.max(200, Math.min(panelW - left - reserve, Math.round(panelW * 0.62)));
    }

    _naturalWidth() {
        try { return this._mainBox.get_preferred_width(-1)[1]; }
        catch (e) { return 0; }
    }

    _pruneCollapsed(entries) {
        const valid = new Set();
        for (const e of entries)
            for (const g of e.entry.groups)
                if (g.count > 1) valid.add(g.key);
        for (const key of [...this._collapsed])
            if (!valid.has(key)) this._collapsed.delete(key);
    }

    _collapseCandidates(entries) {
        if (this._settings.get_boolean('group-apps-always')) return [];

        const activeIdx = Model.WorkspaceManager.get_active_workspace_index();
        const out = [];
        for (const e of entries) {
            for (const g of e.entry.groups)
                if (g.count > 1) out.push({ key: g.key, count: g.count, wsIndex: e.entry.index });
        }
        out.sort((a, b) =>
            b.count - a.count ||
            (Number(b.wsIndex === activeIdx) - Number(a.wsIndex === activeIdx)) ||
            a.wsIndex - b.wsIndex);
        return out;
    }

    _solveGrouping() {
        const budget = this._widthBudget();
        this._pruneCollapsed(this._entries);
        const candidates = this._collapseCandidates(this._entries);

        this._denseStep = 0;
        this._renderContents();

        let steps = 0;

        if (this._naturalWidth() > budget) {
            for (const c of candidates) {
                if (steps++ >= MAX_SOLVE_STEPS) break;
                if (this._collapsed.has(c.key)) continue;
                this._collapsed.add(c.key);
                this._renderContents();
                if (this._naturalWidth() <= budget) break;
            }
        } else {
            const reverted = [...candidates].reverse();
            for (const c of reverted) {
                if (steps++ >= MAX_SOLVE_STEPS) break;
                if (!this._collapsed.has(c.key)) continue;
                this._collapsed.delete(c.key);
                this._renderContents();
                if (budget - this._naturalWidth() < SLACK_PX) {
                    this._collapsed.add(c.key);
                    this._renderContents();
                    break;
                }
            }
        }

        let rungs = 0;
        while (this._naturalWidth() > budget &&
            this._denseStep < REL.denseLadder.length - 1 &&
            rungs++ < REL.denseLadder.length) {
            this._denseStep++;
            this._renderContents();
        }

        this._thumbsBox.style_class = this._collapsed.size > 0
            ? 'workspace-indicator-class grouped-layout'
            : 'workspace-indicator-class';
    }

    _renderContents() {
        for (const ctrl of this._controllers.values()) {
            const parent = ctrl.actor.get_parent();
            if (parent) parent.remove_child(ctrl.actor);
        }
        this._groupIcons.clear();

        const sz = this._iconSize();
        const dense = this._entries.some(e => this._isGrouped(e.entry));

        for (const shell of this._entries) {
            const { entry, content } = shell;
            content.destroy_all_children();
            content.spacing = dense ? 3 : 6;

            if (!entry.windows.length) continue;

            for (const group of entry.groups) {
                if (this._isCollapsed(group)) {
                    content.add_child(this._buildGroupIcon(shell, group, sz));
                    continue;
                }
                group.windows.forEach(w =>
                    content.add_child(this._windowActor(w, entry.index, sz, shell.strip)));
            }
        }
    }

    _windowActor(w, wsIndex, iconSize, strip) {
        const key = `${w.get_id()}:${wsIndex}`;
        let ctrl = this._controllers.get(key);

        if (ctrl?.stale) {
            ctrl.destroy();
            this._controllers.delete(key);
            ctrl = undefined;
        }

        if (ctrl) {
            ctrl.setStrip(strip);
        } else {
            const { actor, icon } = UI.createWindowIconActor(w, iconSize);
            ctrl = new Interactions.WindowIconController({
                window: w, actor, icon,
                settings: this._settings,
                strip,
                onRequestRender: () => { ctrl.stale = true; this._queueRender(); },
                onHoverFlyout: (anchor, hoverWsIndex) =>
                    this._openHoverFlyout(anchor, hoverWsIndex, w),
                onHoverExit: () => this._closeHoverFlyout(),
            });
            this._controllers.set(key, ctrl);
        }

        if (w === _settleWindow) { _settleWindow = null; this._settleActor = ctrl.actor; }
        return ctrl.actor;
    }

    _buildGroupIcon(shell, group, iconSize) {
        const { entry } = shell;
        const { actor } = UI.createGroupButton({
            gicon: UI.getWindowAppIcon(group.windows[0]),
            count: group.count,
            size: iconSize,
        });
        actor.add_style_class_name('window-preview-icon');
        actor.accessible_name = `${group.appName}, ${group.count} windows`;
        actor.set_name(`group-${group.key}`);
        actor._groupWindows = group.windows;

        this._groupIcons.set(actor, { shell, entry, group });

        actor.connect('clicked', () => this._activateGroupWorkspace(entry));

        actor.connect('button-press-event', (a, e) => {
            if (e.get_button() === Clutter.BUTTON_SECONDARY) {
                this._openGroupMenu(actor, entry, group);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        actor.connect('notify::hover', () => this._onGroupHover(actor, shell, group));

        actor._delegate = {
            handleDragOver: source => {
                this._dwellGroup(shell, group, actor);
                return shell.strip.handleDragOver(source);
            },
            acceptDrop: (source, dragActor) => {
                this._cancelDwell();
                this._flyout.close(true);
                return shell.strip.acceptDrop(source, dragActor);
            },
        };

        return actor;
    }

    _activateGroupWorkspace(entry) {
        if (this._dragActive()) return;
        entry.workspace.activate(global.get_current_time());
    }

    _openGroupMenu(anchor, entry, group) {
        const app = UI.getWindowApp(group.windows[0]);
        const favorites = AppFavorites.getAppFavorites();

        Interactions.openContextMenu(anchor, menu => {
            if (app) {
                const appId = app.get_id();
                if (app.can_open_new_window())
                    menu.addAction(`New ${group.appName} window`,
                        () => app.open_new_window(global.get_current_time()));

                const appInfo = app.get_app_info();
                const actions = appInfo?.list_actions();
                if (actions?.length) {
                    for (const action of actions)
                        menu.addAction(`${appInfo.get_action_name(action)}`,
                            () => app.launch_action(action, 0, -1));
                }

                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                const isFav = favorites.isFavorite(appId);
                menu.addAction(isFav ? `Unpin ${group.appName}` : `Pin ${group.appName}`,
                    () => isFav ? favorites.removeFavorite(appId)
                        : favorites.addFavorite(appId));
                menu.addAction(`Close all ${group.appName} windows on workspace ${entry.index}`,
                    () => {
                        const now = global.get_current_time();
                        for (const w of group.windows) w.delete(now);
                    });
            }

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const wsWindows = Model.getModelWindows(entry.workspace);
            menu.addAction('Close all windows on all workspaces', () => {
                const now = global.get_current_time();
                for (const w of Model.getModelWindows(null)) w.delete(now);
            });
            if (wsWindows.length > 0) {
                menu.addAction(`Close all windows except workspace ${entry.index}`, () => {
                    const now = global.get_current_time();
                    for (const w of Model.getModelWindows(null)
                        .filter(w => w.get_workspace() !== entry.workspace))
                        w.delete(now);
                });
                menu.addAction(`Close all windows on workspace ${entry.index}`, () => {
                    const now = global.get_current_time();
                    for (const w of wsWindows) w.delete(now);
                });
            }
        }, { onStateChange: Model.menuIntent });
    }

    _dwellGroup(shell, group, anchor) {
        if (!this._dragActive()) return;
        if (group.count < 2) {
            journal(`[flyout] dwell skipped: ${group.appName} count=${group.count}`);
            return;
        }
        if (this._flyout.isOpen && this._flyout.anchor === anchor) return;
        const armed = this._groupDwell.arm(group.key, () => {
            if (!this._dragActive()) return;
            this._openFlyout(shell, group, anchor);
        });
        if (armed) journal(`[flyout] dwell armed: ${group.appName} x${group.count} key=${group.key}`);
    }

    _cancelDwell() {
        this._groupDwell.cancel();
    }

    _openFlyout(shell, group, anchor, { sticky = false, anchorKey = null, attempt = 0 } = {}) {
        if (!sticky && !this._dragActive()) {
            journal('[flyout] refusing non-sticky open — drag is not active');
            return;
        }

        try {
            const { entry } = shell;
            let anchorOnStage = false;
            try { anchorOnStage = !!anchor.get_stage(); } catch (e) { anchorOnStage = false; }
            journal(`[flyout] _openFlyout ${group.appName} ws=${entry.index} ` +
                `sticky=${sticky} attempt=${attempt} ` +
                `hasStrip=${!!shell.strip} anchorOnStage=${anchorOnStage}`);
            shell.strip.cancel();

            const items = group.windows.map((w, k) => ({
                window: w,
                index: group.indices[k],
                icon: UI.getWindowAppIcon(w),
                title: w.get_title() || 'Untitled Window',
                sub: `${group.appName}`.toUpperCase(),
                color: UI.colorForApp(group.appName),
            }));
            journal(`[flyout] items=${items.length}`);

            const opened = this._flyout.open({
                anchor,
                title: `${group.appName.toUpperCase()} · ${group.count} WINDOWS · WS ${entry.index + 1}`,
                items,
                onDrop: (source, item) => this._dropIntoGroup(shell, source, item),
                sticky,
                anchorKey,
                hoverActivate: sticky,
            });

            if (!opened) {
                let anchorAlive = false;
                try { anchorAlive = !!anchor.get_stage(); } catch (e) { anchorAlive = false; }
                if (attempt < 5 && anchorAlive) {
                    journal(`[flyout] deferring open — retry ${attempt + 1}/5 in 60ms`);
                    this._scope.timeout(60, () => {
                        if (!this._flyout.isOpen)
                            this._openFlyout(shell, group, anchor,
                                { sticky, anchorKey, attempt: attempt + 1 });
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    journal(`[flyout] giving up after ${attempt + 1} attempt(s)`);
                }
            }

            journal(`[flyout] open() returned, isOpen=${this._flyout.isOpen}`);
        } catch (e) {
            journal(`[flyout] _openFlyout THREW: ${e.message}\n${e.stack}`);
        }
    }

    _toggleGroupFlyout(workspaceIndex, wmClass = '') {
        if (this._dragActive()) return false;

        const entry = Model.buildModel().workspaces[workspaceIndex];
        if (!entry) return false;

        const group = entry.groups.find(g =>
            g.count > 1 && g.windows.some(w => w.get_wm_class() === wmClass));
        if (!group) {
            journal(`[flyout.dbus] no badged group with wmclass "${wmClass}" on ws ${workspaceIndex}`);
            return false;
        }

        const key = group.key;
        if (this._flyout.isOpen && this._flyout.anchorKey === key) {
            this._closeGroupFlyout();
            return false;
        }

        let anchor = null, shell = null;
        for (const [actor, info] of this._groupIcons)
            if (info.group.key === group.key) { anchor = actor; shell = info.shell; break; }
        if (!anchor) {
            const ctrl = this._controllers.get(`${group.windows[0].get_id()}:${entry.index}`);
            if (ctrl) {
                anchor = ctrl.actor;
                shell = this._entries.find(s => s.entry.index === entry.index) ?? null;
            }
        }
        if (!anchor || !shell) {
            journal(`[flyout.dbus] no anchor actor for ${group.key}`);
            return false;
        }

        this._openFlyout(shell, group, anchor, { sticky: true, anchorKey: key });
        if (this._flyout.isOpen) {
            this._stickyRequest = { workspaceIndex, wmClass };
            return true;
        }
        return false;
    }

    _closeGroupFlyout() {
        this._stickyRequest = null;
        if (!this._flyout.isOpen) return false;
        journal('[flyout.dbus] close');
        this._flyout.close(true);
        return true;
    }

    _onGroupHover(actor, shell, group) {
        if (this._dragActive()) return;

        if (!actor.hover) {
            Interactions.getTooltip().hide();
            this._cancelHoverGroupDwell(group);
            return;
        }

        Interactions.getTooltip().showAbove(
            actor,
            `${group.appName} — ${group.count} windows`);

        this._groupDwell.arm(`hover-${group.key}`, () => {
            if (this._dragActive()) return;
            Interactions.getTooltip().hide();
            this._openHoverGroupFlyout(shell, group, actor);
        });
    }

    _cancelHoverGroupDwell(group) {
        if (this._groupDwell.key === `hover-${group.key}`) this._groupDwell.cancel();
    }

    _openHoverGroupFlyout(shell, group, anchor) {
        if (this._dragActive()) return;
        if (!anchor.get_stage()) return;

        const key = `hover-group:${group.key}`;
        if (this._flyout.isOpen && this._flyout.anchorKey === key) return;
        if (this._flyout.isOpen) this._flyout.close(true);

        const { entry } = shell;
        const items = group.windows.map((w, k) => ({
            window: w,
            index: group.indices[k],
            icon: UI.getWindowAppIcon(w),
            title: w.get_title() || 'Untitled Window',
            sub: group.appName.toUpperCase(),
            color: UI.colorForApp(group.appName),
        }));

        this._flyout.open({
            anchor,
            title: `${group.appName.toUpperCase()} · ${group.count} WINDOWS · WS ${entry.index + 1}`,
            items,
            onDrop: null,
            sticky: false,
            anchorKey: key,
            hoverActivate: true,
        });
    }

    _openHoverFlyout(anchor, wsIndex, win = null) {
        if (this._dragActive()) return;

        const key = `hover-ws:${wsIndex}`;
        if (this._flyout.isOpen) {
            if (this._flyout.anchorKey === key) {
                this._flyout.retarget(anchor);
                this._flyout.highlightWindow(win);
                return;
            }
            this._flyout.close(true);
        }

        const entry = Model.buildModel().workspaces[wsIndex];
        if (!entry || entry.windows.length === 0) return;

        const items = entry.windows.map(w => {
            const app = UI.getWindowApp(w);
            const appName = app?.get_name() || w.get_wm_class() || 'Unknown';
            return {
                window: w,
                icon: UI.getWindowAppIcon(w),
                title: w.get_title() || 'Untitled Window',
                sub: appName.toUpperCase(),
                color: UI.colorForApp(appName),
            };
        });

        const n = items.length;
        this._flyout.open({
            anchor,
            title: `WORKSPACE ${wsIndex + 1} · ${n} ${n === 1 ? 'WINDOW' : 'WINDOWS'}`,
            items,
            onDrop: null,
            sticky: false,
            anchorKey: key,
            hoverActivate: true,
            selectedWindow: win,
        });
    }

    _closeHoverFlyout() {
        if (!this._flyout?.isOpen) return;
        if (!this._flyout.anchorKey?.startsWith('hover-')) return;
        this._flyout.close(true);
    }

    _dropIntoGroup(shell, source, item) {
        const { entry } = shell;
        const win = source?._dragPayload?.window;
        if (!win) return false;

        const sameWs = win.get_workspace() === entry.workspace;
        Model.placeWindowNear(win, entry.workspace, item?.window ?? null, true);

        if (!sameWs) {
            const monitorIndex = Main.layoutManager.findIndexForActor(shell.actor);
            if (monitorIndex !== win.get_monitor()) win.move_to_monitor(monitorIndex);
            win.change_workspace(entry.workspace);
        }

        _settleWindow = win;
        Model.setIntent({ drag: null, hintWs: null });
        return true;
    }

    _onExternalChanged(state) {
        if (state) {
            if (!this._extPoll.running) this._startExternalPoll();
        } else {
            this._stopExternalPoll(true);
        }
    }

    _stopExternalPoll(teardown) {
        this._extPoll.stop();
        if (this._geoRelogId) { this._scope.cancel(this._geoRelogId); this._geoRelogId = 0; }

        this._focusRelease?.();
        this._focusRelease = null;

        if (!teardown) return;

        this._cancelExtRow();
        this._cancelExtWorkspace();
        this._cancelDwell();
        this._flyout?.close(true);

        this._extGroupKey = null;

        if (Model.intent.drag) Model.setIntent({ drag: null });
        Model.setIntent({ hintWs: null });
        this._queueRender();
    }

    _startExternalPoll() {
        this._cancelDwell();
        this._flyout.close(true);

        if (!this._focusRelease) this._focusRelease = Model.holdFocusHistory();

        this._extRowDwell.cancel();
        this._extSawButton = false;
        this._extWsDwell.cancel();
        this._extGroupKey = null;
        this._extLogAt = 0;
        if (this._geoRelogId) { this._scope.cancel(this._geoRelogId); this._geoRelogId = 0; }

        journal('[ext] poll START');

        if (this._extPoll.running) return;
        this._extPoll.start();

        this._geoRelogId = this._scope.timeout(120, () => {
            this._geoRelogId = 0;
            if (externalDrag.active) this._logGroupIcons();
            return GLib.SOURCE_REMOVE;
        });
    }

    _logGroupIcons(attempt = 0) {
        journal(`[ext] groupIcons=${this._groupIcons.size}`);

        let pending = false;
        for (const [actor, info] of this._groupIcons) {
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            const ready = [x, y, w, h].every(Number.isFinite);
            if (!ready) pending = true;

            journal(`[ext]   group ${info.group.appName} x${info.group.count} ` +
                `pos=${fmtNum(x)},${fmtNum(y)} size=${fmtNum(w)}x${fmtNum(h)} ` +
                `visible=${actor.visible} mapped=${actor.is_mapped()} onStage=${!!actor.get_stage()}`);

            if (!ready) continue;

            let a = actor;
            let depth = 0;
            while (a && depth++ < 12) {
                let line;
                try {
                    const [px, py] = a.get_transformed_position();
                    const [aw, ah] = a.get_size();
                    line = `[ext]     ${a.constructor.name}` +
                        `${a.name ? `(${a.name})` : ''} ` +
                        `pos=${fmtNum(px)},${fmtNum(py)} size=${fmtNum(aw)}x${fmtNum(ah)} ` +
                        `mapped=${a.is_mapped()} scale=${a.scale_x},${a.scale_y}`;
                } catch (e) {
                    line = `[ext]     ${a.constructor?.name} threw: ${e.message}`;
                }
                journal(line);
                a = a.get_parent();
            }
        }

        if (pending && attempt < 3) {
            journal(`[ext] geometry pending — re-logging in 120ms (${attempt + 1}/3)`);
            if (this._geoRelogId) this._scope.cancel(this._geoRelogId);
            this._geoRelogId = this._scope.timeout(120, () => {
                this._geoRelogId = 0;
                if (externalDrag.active) this._logGroupIcons(attempt + 1);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _externalTickInner() {
        if (!externalDrag.active) {
            this._stopExternalPoll(true);
            return false;
        }

        const [x, y, mods] = global.get_pointer();

        if (y < Main.panel.height + 4) {
            journal(`[ext] PANEL x=${x} y=${y} ` +
                `overGroup=${!!this._groupIconAt(x, y)} ` +
                `overWinIcon=${!!this._windowIconAt(x, y)} ` +
                `overThumb=${!!this._thumbnailAt(x, y)}`);
        }

        const nowMs = GLib.get_monotonic_time() / 1000;
        if (nowMs - (this._extLogAt ?? 0) > 500) {
            this._extLogAt = nowMs;
            const picked = global.stage.get_actor_at_pos(
                Clutter.PickMode.REACTIVE, x, y);
            journal(`[ext] tick x=${x} y=${y} mods=${mods} held=${buttonHeld(mods)} ` +
                `sawButton=${this._extSawButton} ` +
                `flyoutOpen=${this._flyout.isOpen} sticky=${this._flyout.sticky} ` +
                `overGroup=${!!this._groupIconAt(x, y)} ` +
                `overWinIcon=${!!this._windowIconAt(x, y)} ` +
                `overThumb=${!!this._thumbnailAt(x, y)} ` +
                `picked=${picked?.constructor?.name}:${picked?.name ?? ''}`);
        }

        if (buttonHeld(mods)) this._extSawButton = true;
        else if (this._extSawButton) {
            journal('[ext] button released -> end');
            externalDrag.end('button-released');
            return false;
        }

        if (this._flyout.isOpen) {
            const hit = this._flyout.pointerAt(x, y);
            if (hit?.item?.window) this._trackExternalRow(hit.item.window);
            else this._cancelExtRow();
            return true;
        }

        const group = this._groupIconAt(x, y);
        if (group) {
            if (this._extGroupKey !== group.group.key) {
                this._extGroupKey = group.group.key;
                const [gx, gy] = group.actor.get_transformed_position();
                journal(`[ext] group hit ${group.group.appName} x${group.group.count} ` +
                    `key=${group.group.key} anchorPos=${fmtNum(gx)},${fmtNum(gy)}`);
            }
            this._dwellGroup(group.shell, group.group, group.actor);
            this._cancelExtRow();
            return true;
        }
        if (this._extGroupKey) {
            this._extGroupKey = null;
            journal('[ext] group left');
        }

        const ctrl = this._windowIconAt(x, y);
        if (ctrl) {
            ctrl.notifyExternalDrag();
            this._cancelDwell();
            this._cancelExtRow();
            return true;
        }

        this._cancelDwell();
        this._maybeDwellWorkspace(x, y);
        return true;
    }

    _trackExternalRow(win) {
        this._extRowDwell.arm(String(win.get_id()), () => this._previewExternalWindow(win));
    }

    _cancelExtRow() {
        this._extRowDwell.cancel();
    }

    _previewExternalWindow(win) {
        WorkspaceActions.focusWindow(win);
        try {
            journal(`[ext] preview ${win.get_id()} "${win.get_title()}" (kept maximized)`);
        } catch (e) { /* window may have been destroyed mid-call */ }
    }

    _maybeDwellWorkspace(x, y) {
        const thumb = this._thumbnailAt(x, y);
        if (!thumb || thumb.workspace === Model.WorkspaceManager.get_active_workspace()) {
            this._cancelExtWorkspace();
            return;
        }

        this._extWsDwell.arm(`ws:${thumb.index}`, () => {
            if (!externalDrag.active) return;
            try {
                Model.WorkspaceManager.get_workspace_by_index(thumb.index)
                    ?.activate(global.get_current_time());
            } catch (e) { /* gone */ }
        });

        Model.setIntent({ hintWs: thumb.index });
    }

    _cancelExtWorkspace() {
        this._extWsDwell.cancel();
    }

    _actorHit(x, y, actor) {
        if (!actor || !actor.get_stage() || !actor.visible) return false;
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        if (![ax, ay, aw, ah].every(Number.isFinite)) return false;
        if (ay + ah < Main.panel.y) return false;
        return x >= ax && x <= ax + aw && y >= ay && y <= ay + ah;
    }

    _groupIconAt(x, y) {
        for (const [actor, info] of this._groupIcons)
            if (this._actorHit(x, y, actor)) return { ...info, actor };
        return null;
    }

    _windowIconAt(x, y) {
        for (const ctrl of this._controllers.values())
            if (this._actorHit(x, y, ctrl.actor)) return ctrl;
        return null;
    }

    _anchorForKey(key) {
        const alive = a => { try { return !!a?.get_stage(); } catch (e) { return false; } };

        if (key.startsWith('hover-ws:')) {
            const wsIndex = parseInt(key.slice('hover-ws:'.length), 10);
            const shell = this._entries.find(s => s.entry.index === wsIndex);
            if (!shell) return null;
            for (const w of shell.entry.windows) {
                const ctrl = this._controllers.get(`${w.get_id()}:${wsIndex}`);
                if (ctrl && alive(ctrl.actor)) return ctrl.actor;
            }
            for (const [actor, info] of this._groupIcons)
                if (info.entry.index === wsIndex && alive(actor)) return actor;
            return null;
        }

        const groupKey = key.startsWith('hover-group:') ? key.slice('hover-group:'.length) : key;
        for (const [actor, info] of this._groupIcons)
            if (info.group.key === groupKey && alive(actor)) return actor;

        for (const shell of this._entries) {
            const group = shell.entry.groups.find(g => g.key === groupKey);
            if (!group) continue;
            const ctrl = this._controllers.get(`${group.windows[0].get_id()}:${shell.entry.index}`);
            if (ctrl && alive(ctrl.actor)) return ctrl.actor;
        }
        return null;
    }

    _syncHint() {
        const s = this._settings;
        const wsIndex = Model.intent.hintWs;
        const target = (wsIndex !== null && this._thumbsBox)
            ? this._thumbsBox.get_child_at_index(wsIndex)
            : null;
        if (!target || !s.get_boolean('show-workspace-names')) {
            Interactions.getTooltip().hide();
            return;
        }
        Interactions.getTooltip().showAbove(
            target,
            Meta.prefs_get_workspace_name(wsIndex));
    }

    _openThumbnailMenu(anchor, workspace) {
        const windows = Model.getModelWindows(workspace);
        Interactions.openContextMenu(anchor, menu => {
            menu.addAction('Close all windows on all workspaces', () => {
                const now = global.get_current_time();
                for (const w of Model.getModelWindows(null)) w.delete(now);
            });
            if (windows.length > 0) {
                menu.addAction(`Close all windows except workspace ${workspace.index()}`, () => {
                    const now = global.get_current_time();
                    for (const w of Model.getModelWindows(null).filter(w => w.get_workspace() !== workspace))
                        w.delete(now);
                });
                menu.addAction(`Close all windows on workspace ${workspace.index()}`, () => {
                    const now = global.get_current_time();
                    for (const w of windows) w.delete(now);
                });
            }
        }, { onStateChange: Model.menuIntent });
    }

    // Ghost insertion (actor + side) -> { neighbor: Meta.Window, before }.
    // A group button stands for its first window (before) or last (after).
    _resolveDrop(insertion) {
        const a = insertion?.neighbor;
        if (!a) return null;
        const wins = a._dragPayload?.window ? [a._dragPayload.window] : a._groupWindows;
        if (!wins?.length) return null;
        return {
            neighbor: insertion.insertBefore ? wins[0] : wins[wins.length - 1],
            before: insertion.insertBefore,
        };
    }

    _dropOnWorkspace(thumb, entry, source, target, dragActor) {
        Model.setIntent({ hintWs: null });

        const win = source?._dragPayload?.window ?? null;
        if (!win) return true;

        const sameWs = win.get_workspace() === entry.workspace;

        if (dragActor && dragActor !== source._actor) {
            dragActor.get_parent()?.remove_child(dragActor);
            try { dragActor.destroy(); } catch (e) { /* ignore */ }
        }

        if (sameWs && !target) { Model.setIntent({ drag: null }); return true; }

        Model.placeWindowNear(win, entry.workspace,
            target?.neighbor ?? null, target?.before ?? true);
        if (!sameWs) {
            const monitorIndex = Main.layoutManager.findIndexForActor(thumb);
            if (monitorIndex !== win.get_monitor()) win.move_to_monitor(monitorIndex);
            win.change_workspace(entry.workspace);
        }
        _settleWindow = win;
        Model.setIntent({ drag: null });
        return true;
    }

    _ensureLeavePoll() {
        if (this._leavePollId) return;
        this._leavePollId = this._scope.timeout(100, () => {
            const [px, py, mods] = global.get_pointer();
            const held = buttonHeld(mods) || externalDrag.active;
            if (!held || !this._thumbnailAt(px, py)) {
                this._leavePollId = 0;
                this._cancelDwell();
                Model.setIntent({ hintWs: null });
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
            if (![tx, ty, tw, th].every(Number.isFinite)) continue;
            if (ty + th < Main.panel.y) continue;
            if (x >= tx && x <= tx + tw && y >= ty && y <= ty + th)
                return { ...thumb._wsEntry, actor: thumb };
        }
        return null;
    }

    destroy() {
        this._cancelDwell();
        this._stopExternalPoll(true);
        this._extUnsub?.();
        this._extUnsub = null;

        this._renderCoalescer.cancel();
        this._unsubIntent?.(); this._unsubIntent = null;
        this._unsubWorld?.(); this._unsubWorld = null;
        Model.resetIntent();

        for (const ctrl of this._controllers.values()) ctrl.destroy();
        this._controllers.clear();

        this._flyout?.destroy();
        this._flyout = null;

        this._groupIcons.clear();

        this._ghost?.clear();
        this._ghost = null;
        _instance = null;
        _settleWindow = null;

        this._scope.dispose();
        this._mainBox?.destroy();

        Main.panel.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

        super.destroy();
    }
}