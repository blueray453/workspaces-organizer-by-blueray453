// ===== FILE: ./lib/workspaceIndicator.js =====
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as ExtensionModule from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as Model from './model.js';
import * as Scheduling from './scheduling.js';
import * as Interactions from './interactions.js';
import * as UI from './ui.js';
import { GroupFlyout } from './flyout.js';
import { externalDrag, buttonHeld } from './externalDrag.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const _ = ExtensionModule.gettext;

let _instance = null;
let _settleWindow = null;

const MIN_RENDER_INTERVAL_MS = 100;

// Internal window drag: dwell before the flyout opens.
const DWELL_MS = 150;
// External (file/text) drag: pointer poll, dwell, preview.
const EXT_TICK_MS = 40;
// Hover-to-preview delay. Shorter than the flyout dwell so moving into the
// popup feels responsive; matches the overlay's _scheduleReveal timing.
const EXT_PREVIEW_MS = 150;
const EXT_WS_DWELL_MS = 500;

const SLACK_PX = 32;
const MAX_SOLVE_STEPS = 6;

const SIZE_LADDER = [1, 0.9, 0.78, 0.66, 0.55];
const SIZE_FLOOR = 20;

// get_transformed_position() etc. return NaN for not-yet-allocated
// actors; keep the logs readable either way.
const fmtNum = v => Number.isFinite(v) ? String(Math.round(v)) : 'NaN';

export function thumbnailAt(x, y) { return _instance?._thumbnailAt(x, y) ?? null; }
export function settleOnNextRender(window) { _settleWindow = window; }

export function toggleGroupFlyout(workspaceIndex, appId = '') {
    return _instance?._toggleGroupFlyout(workspaceIndex, appId) ?? false;
}

export function closeGroupFlyout() {
    _instance?._closeGroupFlyout();
}

export class WorkspaceIndicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor(settings, commands) {
        super(0.0, _('Workspace Indicator'));
        this.reactive = false;
        this._settings = settings;
        this._commands = commands;
        _instance = this;

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

        this._dwellId = 0;
        this._dwellKey = null;

        this._groupIcons = new Map();

        this._flyout = new GroupFlyout(settings);

        // External drag state
        this._extPollId = 0;
        this._extRowKey = null;
        this._extRowTimer = 0;
        this._extWsKey = null;
        this._extWsTimer = 0;
        this._extMaximized = null;
        this._extSawButton = false;
        this._extGroupKey = null;   // last group the external poll hovered
        this._geoRelogId = 0;       // deferred geometry re-log source

        this._lastHintWs = Model.intent.hintWs;
        this._lastDragActive = !!Model.intent.drag;
        this._lastMenuOpen = !!Model.intent.menuOpen;

        this._ghost = Interactions.createReorderGhost({
            iconSize: () => settings.get_int('icon-size'),
        });

        this._mainBox = new St.BoxLayout({
            style_class: 'workspace-indicator-main-box',
            y_expand: true, x_expand: true, reactive: true,
        });
        this.add_child(this._mainBox);

        Model.onIntentChange(() => this._onIntentChanged());
        Model.onWorldChange(() => this._queueRender());

        this._extUnsub = externalDrag.onChanged(state => this._onExternalChanged(state));

        this._render();
    }

    // ==================== INTENT ====================
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

        // A sticky (DBus-opened) flyout has no drag lifetime — it survives
        // intent churn and is closed explicitly or by a re-render.
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

    // ==================== RENDER ====================
    _render() {
        if (Model.intent.menuOpen) return;
        if (Model.intent.drag) return;
        if (externalDrag.active) return;

        // A rebuild replaces every group icon; an anchored flyout would be
        // left pointing at destroyed actors (NaN geometry, dead hit tests).
        if (this._flyout.isOpen) {
            journal('[flyout] re-render -> closing anchored flyout');
            this._flyout.close(true);
        }

        this._ghost.clear();

        const model = Model.buildModel();
        Model.logModel(model);
        const s = this._settings;

        const iconSize = s.get_int('icon-size');
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

        if (this._settleActor) Interactions.settleIcon(this._settleActor);
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

        const iconSize = s.get_int('toolbar-icon-size');
        if (s.get_boolean('show-window-button')) {
            const b = UI.createToolbarButton('focus-windows-symbolic', iconSize, 'All windows');
            b.connect('clicked', () => this._commands.showAllWindows());
            this._staticBox.add_child(b);
        }
        if (s.get_boolean('show-drun-button')) {
            const b = UI.createToolbarButton('view-app-grid-symbolic', iconSize, 'Show apps');
            b.connect('clicked', () => this._commands.showAllApps());
            this._staticBox.add_child(b);
        }
        if (s.get_boolean('show-workspace-names')) {
            this._nameLabel = UI.createWorkspaceNameLabel(
                Meta.prefs_get_workspace_name(Model.WorkspaceManager.get_active_workspace_index()),
                s.get_int('workspace-name-font-size'));
            this._staticBox.add_child(this._nameLabel);
        }
    }

    // ==================== THUMBNAIL SHELL ====================
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
            onDrop: (source, dropIndex, dragActor) => {
                this._cancelDwell();
                this._flyout.close(true);
                const grouped = this._isGrouped(entry);
                return this._dropOnWorkspace(thumb, entry, source,
                    grouped ? null : dropIndex, dragActor);
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

    // ==================== GROUPING ====================
    _isCollapsed(entry, group) {
        if (group.count < 2) return false;
        if (this._settings.get_boolean('group-apps-always')) return true;
        if (!entry.direct) return true;
        return this._collapsed.has(group.key);
    }

    _isGrouped(entry) {
        return entry.groups.some(g => this._isCollapsed(entry, g));
    }

    _iconSize() {
        const base = this._settings.get_int('icon-size');
        const dense = this._entries.some(e => this._isGrouped(e.entry));
        if (!dense) return base;

        const rung = Math.min(this._denseStep, SIZE_LADDER.length - 1);
        return Math.max(SIZE_FLOOR, Math.round(base * SIZE_LADDER[rung]));
    }

    _widthBudget() {
        const panelW = Main.panel.width > 0 ? Main.panel.width : Model.screenWidth;
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
            if (!e.entry.direct) continue;
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
            this._denseStep < SIZE_LADDER.length - 1 &&
            rungs++ < SIZE_LADDER.length) {
            this._denseStep++;
            this._renderContents();
        }

        this._thumbsBox.style_class = this._collapsed.size > 0
            ? 'workspace-indicator-class grouped-layout'
            : 'workspace-indicator-class';
    }

    // ==================== CONTENTS ====================
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

            if (!entry.windows.length) {
                content.add_child(new St.Label({ style_class: 'ws-empty', text: 'empty' }));
                continue;
            }

            for (const group of entry.groups) {
                if (this._isCollapsed(entry, group)) {
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

        this._groupIcons.set(actor, { shell, entry, group });

        actor.connect('clicked', () => this._openGroupSelector(entry, group));

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

    _openGroupSelector(entry, group) {
        if (this._dragActive()) return;
        this._flyout.close(true);
        this._commands.showGroupWindows?.(entry.index, group.appId);
    }

    // ==================== FLYOUT ====================
    _dwellGroup(shell, group, anchor) {
        if (group.count < 2) {
            journal(`[flyout] dwell skipped: ${group.appName} count=${group.count}`);
            return;
        }
        if (this._flyout.isOpen && this._flyout.anchor === anchor) return;
        if (this._dwellKey === group.key) return;

        journal(`[flyout] dwell armed: ${group.appName} x${group.count} key=${group.key}`);
        this._cancelDwell();
        this._dwellKey = group.key;
        this._dwellId = this._scope.timeout(DWELL_MS, () => {
            this._dwellId = 0;
            this._dwellKey = null;
            const active = this._dragActive();
            journal(`[flyout] dwell fired: dragActive=${active}`);
            if (!active) return GLib.SOURCE_REMOVE;
            this._openFlyout(shell, group, anchor);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDwell() {
        if (this._dwellId) { this._scope.cancel(this._dwellId); this._dwellId = 0; }
        this._dwellKey = null;
    }

    _openFlyout(shell, group, anchor, { sticky = false, anchorKey = null, attempt = 0 } = {}) {
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
            });

            // open() refuses anchors whose allocation has not landed yet
            // (NaN geometry). Retry a few times; a re-render in between
            // replaces the anchor and the retry aborts itself.
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

    /**
     * DBus entry point: open (or close) the group flyout without a drag.
     * appId '' selects the largest badged group on the workspace. Sticky:
     * no pointer watchdog — stays open until toggled again, CloseFlyout,
     * a row click, or the next re-render.
     */
    _toggleGroupFlyout(workspaceIndex, appId = '') {
        try {
            if (this._dragActive()) {
                journal('[flyout.dbus] rejected: drag active');
                return false;
            }

            const key = `${workspaceIndex}::${appId || '*'}`;
            if (this._flyout.isOpen && this._flyout.anchorKey === key) {
                journal(`[flyout.dbus] toggle off (${key})`);
                this._closeGroupFlyout();
                return false;
            }

            const entry = Model.buildModel().workspaces[workspaceIndex];
            if (!entry) {
                journal(`[flyout.dbus] no workspace ${workspaceIndex}`);
                return false;
            }

            const group = appId
                ? entry.groups.find(g => g.appId === appId)
                : [...entry.groups].filter(g => g.count > 1)
                    .sort((a, b) => b.count - a.count)[0];
            if (!group) {
                journal(`[flyout.dbus] no group appId=${appId || '(largest)'} on ws ${workspaceIndex}`);
                return false;
            }
            if (group.count < 2) {
                journal(`[flyout.dbus] ${group.appName} has ${group.count} window(s) — ` +
                    `the flyout needs a badged group (2+)`);
                return false;
            }

            let anchor = null, shell = null;
            for (const [actor, info] of this._groupIcons) {
                if (info.group.key === group.key) { anchor = actor; shell = info.shell; break; }
            }
            if (!anchor) {
                // Group rendered expanded (one icon per window): anchor to
                // the app's first window icon instead of refusing.
                const ctrl = this._controllers.get(
                    `${group.windows[0].get_id()}:${entry.index}`);
                if (ctrl) {
                    anchor = ctrl.actor;
                    shell = this._entries.find(s => s.entry.index === entry.index) ?? null;
                    journal('[flyout.dbus] group not collapsed; anchoring to window icon');
                }
            }
            if (!anchor || !shell) {
                journal(`[flyout.dbus] no anchor actor for ${group.key}`);
                return false;
            }

            journal(`[flyout.dbus] toggle on ${group.appName} x${group.count} ws=${entry.index}`);
            this._openFlyout(shell, group, anchor, { sticky: true, anchorKey: key });
            return this._flyout.isOpen;
        } catch (e) {
            journal(`[flyout.dbus] THREW: ${e.message}\n${e.stack}`);
            return false;
        }
    }

    _closeGroupFlyout() {
        if (!this._flyout.isOpen) { journal('[flyout.dbus] close: not open'); return; }
        journal('[flyout.dbus] close');
        this._flyout.close(true);
    }

    _dropIntoGroup(shell, source, item) {
        const { entry } = shell;
        const win = source?._dragPayload?.window;
        if (!win) return false;

        const sameWs = win.get_workspace() === entry.workspace;
        Model.placeWindow(win, entry.workspace, item ? item.index : null);

        if (!sameWs) {
            const monitorIndex = Main.layoutManager.findIndexForActor(shell.actor);
            if (monitorIndex !== win.get_monitor()) win.move_to_monitor(monitorIndex);
            win.change_workspace(entry.workspace);
        }

        _settleWindow = win;
        Model.setIntent({ drag: null, hintWs: null });
        return true;
    }

    // ==================== EXTERNAL DRAG ====================
    _onExternalChanged(state) {
        if (state) {
            if (this._extPollId) return;
            this._startExternalPoll();
        } else {
            this._stopExternalPoll(true);
        }
    }

    _stopExternalPoll(teardown) {
        if (this._extPollId) { this._scope.cancel(this._extPollId); this._extPollId = 0; }
        if (this._geoRelogId) { this._scope.cancel(this._geoRelogId); this._geoRelogId = 0; }
        if (!teardown) return;

        this._cancelExtRow();
        this._cancelExtWorkspace();
        this._cancelDwell();
        this._flyout?.close(true);
        this._restoreExternalMaximize();

        this._extRowKey = null;
        this._extWsKey = null;
        this._extGroupKey = null;

        Model.setIntent({ hintWs: null });
        this._queueRender();
    }

    _startExternalPoll() {
        this._cancelDwell();
        this._flyout.close(true);

        this._extRowKey = null;
        this._extMaximized = null;
        this._extSawButton = false;
        this._extWsKey = null;
        this._extGroupKey = null;
        this._extLogAt = 0;
        if (this._geoRelogId) { this._scope.cancel(this._geoRelogId); this._geoRelogId = 0; }

        journal('[ext] poll START');
        this._logGroupIcons();

        if (this._extPollId) return;
        this._extPollId = this._scope.timeout(EXT_TICK_MS, () => this._externalTick());
    }

    _logGroupIcons(attempt = 0) {
        journal(`[ext] groupIcons=${this._groupIcons.size}`);

        let pending = false;
        for (const [actor, info] of this._groupIcons) {
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            const ready = [x, y, w, h].every(Number.isFinite);
            if (!ready) pending = true;

            // get_transformed_*() return NaN until the actor has been
            // allocated (next stage paint) — visible/onStage stay true,
            // which is why the old line looked contradictory.
            journal(`[ext]   group ${info.group.appName} x${info.group.count} ` +
                `pos=${fmtNum(x)},${fmtNum(y)} size=${fmtNum(w)}x${fmtNum(h)} ` +
                `visible=${actor.visible} mapped=${actor.is_mapped()} onStage=${!!actor.get_stage()}`);

            if (!ready) continue;   // ancestor chain is noise until allocation lands

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
            // Re-log once the frame has been allocated so the journal gets
            // real geometry instead of a NaN line.
            journal(`[ext] geometry pending — re-logging in 120ms (${attempt + 1}/3)`);
            if (this._geoRelogId) this._scope.cancel(this._geoRelogId);
            this._geoRelogId = this._scope.timeout(120, () => {
                this._geoRelogId = 0;
                if (externalDrag.active) this._logGroupIcons(attempt + 1);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _externalTick() {
        try {
            return this._externalTickInner();
        } catch (e) {
            journal(`[ext] tick THREW: ${e.message}\n${e.stack}`);
            return GLib.SOURCE_CONTINUE;
        }
    }

    _shellForWindow(window) {
        const ws = window.get_workspace();
        const idx = ws ? ws.index()
            : Model.WorkspaceManager.get_active_workspace_index();
        return this._entries.find(s => s.entry.index === idx)
            ?? this._entries[0] ?? null;
    }

    _externalTickInner() {
        if (!externalDrag.active) {
            this._extPollId = 0;
            this._stopExternalPoll(true);
            return GLib.SOURCE_REMOVE;
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
            return GLib.SOURCE_REMOVE;
        }

        // (1) Flyout is up: hover a row to preview that window, leave to
        // restore. The flyout is NOT closed on preview — the user can
        // move between rows to compare, or drag back out to cancel.
        if (this._flyout.isOpen) {
            const hit = this._flyout.pointerAt(x, y);
            if (hit?.item?.window) this._trackExternalRow(hit.item.window);
            else this._cancelExtRow();
            return GLib.SOURCE_CONTINUE;
        }

        // (2) A badged app group — geometric hit test, so this works even
        // when stage picking is unreliable during an external drag.
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
            return GLib.SOURCE_CONTINUE;
        }
        if (this._extGroupKey) {
            this._extGroupKey = null;
            journal('[ext] group left');
        }

        // (3) A plain window icon — dwell to open the flyout when the app
        // has siblings on this workspace, otherwise fall back to the
        // classic auto-activate reveal.
        const ctrl = this._windowIconAt(x, y);
        if (ctrl) {
            const shell = this._shellForWindow(ctrl.window);
            const ownerGroup = shell?.entry.groups
                .find(g => g.windows.includes(ctrl.window));
            if (shell && ownerGroup && ownerGroup.count >= 2) {
                this._dwellGroup(shell, ownerGroup, ctrl.actor);
            } else {
                ctrl.notifyExternalDrag();
                this._cancelDwell();
            }
            this._cancelExtRow();
            return GLib.SOURCE_CONTINUE;
        }

        this._cancelDwell();

        // (4) A workspace thumbnail
        this._maybeDwellWorkspace(x, y);
        return GLib.SOURCE_CONTINUE;
    }

    _trackExternalRow(win) {
        const key = String(win.get_id());
        if (this._extRowKey === key) return;

        this._extRowKey = key;
        this._cancelExtRowTimer();

        // Switching rows: restore whatever we last maximized before
        // scheduling the new preview. Keep the flyout open.
        if (this._extMaximized && this._extMaximized !== win)
            this._restoreExternalMaximize();

        this._extRowTimer = this._scope.timeout(EXT_PREVIEW_MS, () => {
            this._extRowTimer = 0;
            this._previewExternalWindow(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelExtRow() {
        this._extRowKey = null;
        this._cancelExtRowTimer();
        this._restoreExternalMaximize();
    }

    _cancelExtRowTimer() {
        if (this._extRowTimer) { this._scope.cancel(this._extRowTimer); this._extRowTimer = 0; }
    }

    /**
     * Hover-to-preview: mirror WindowSearchOverlay._revealWindow.
     * Maximizes and focuses the target so the foreign drag has an
     * obvious drop target, but leaves the flyout open so the pointer
     * can move to another row without re-dwelling on the badge.
     */
    _previewExternalWindow(win) {
        try {
            const time = global.get_current_time();
            if (win.minimized) win.unminimize();
            if (win.get_maximized() !== Meta.MaximizeFlags.BOTH) {
                win.maximize(Meta.MaximizeFlags.BOTH);
                this._extMaximized = win;
            }
            const ws = win.get_workspace();
            if (ws) ws.activate_with_focus(win, time);
            else win.activate(time);
            journal(`[ext] preview ${win.get_id()} "${win.get_title()}"`);
        } catch (e) {
            journal(`[WorkspaceIndicator] preview failed: ${e.message}`);
        }
    }

    _restoreExternalMaximize() {
        const win = this._extMaximized;
        this._extMaximized = null;
        if (!win) return;
        try {
            if (win.get_maximized() === Meta.MaximizeFlags.BOTH)
                win.unmaximize(Meta.MaximizeFlags.BOTH);
            journal(`[ext] restore ${win.get_id()} "${win.get_title()}"`);
        } catch (e) { /* window gone */ }
    }

    _maybeDwellWorkspace(x, y) {
        const thumb = this._thumbnailAt(x, y);
        if (!thumb || thumb.workspace === Model.WorkspaceManager.get_active_workspace()) {
            this._cancelExtWorkspace();
            return;
        }

        const key = `ws:${thumb.index}`;
        if (this._extWsKey !== key) {
            this._extWsKey = key;
            this._cancelExtWorkspace();
            this._extWsKey = key;
            this._extWsTimer = this._scope.timeout(EXT_WS_DWELL_MS, () => {
                this._extWsTimer = 0;
                if (!externalDrag.active) return GLib.SOURCE_REMOVE;
                const ws = Model.WorkspaceManager.get_workspace_by_index(thumb.index);
                try { ws?.activate(global.get_current_time()); } catch (e) { /* gone */ }
                return GLib.SOURCE_REMOVE;
            });
        }

        Model.setIntent({ hintWs: thumb.index });
    }

    _cancelExtWorkspace() {
        if (this._extWsTimer) { this._scope.cancel(this._extWsTimer); this._extWsTimer = 0; }
        this._extWsKey = null;
    }

    // ---------- hit testing ----------
    // Geometric tests over our own tracked actors instead of
    // global.stage.get_actor_at_pos(): picking can be intercepted by
    // drag-feedback chrome during an external drag, and unallocated actors
    // pick as nothing. `_actorHit` also rejects NaN geometry for free —
    // every comparison against NaN is false.
    _actorHit(x, y, actor) {
        if (!actor || !actor.get_stage() || !actor.visible) return false;
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
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

    // ==================== HINTS / MENUS / DROPS ====================
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
            Meta.prefs_get_workspace_name(wsIndex),
            s.get_int('tooltip-font-size'));
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
        });
    }

    _dropOnWorkspace(thumb, entry, source, index, dragActor) {
        Model.setIntent({ hintWs: null });

        const win = source?._dragPayload?.window ?? null;
        if (!win) return true;

        const sameWs = win.get_workspace() === entry.workspace;

        if (dragActor && dragActor !== source._actor) {
            dragActor.get_parent()?.remove_child(dragActor);
            try { dragActor.destroy(); } catch (e) { /* ignore */ }
        }

        if (sameWs && index === null) { Model.setIntent({ drag: null }); return true; }

        Model.placeWindow(win, entry.workspace, index);
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
            if (x >= tx && x <= tx + tw && y >= ty && y <= ty + th)
                return { ...thumb._wsEntry, actor: thumb };
        }
        return null;
    }

    // ==================== LIFECYCLE ====================
    destroy() {
        this._cancelDwell();
        this._stopExternalPoll(true);
        this._extUnsub?.();
        this._extUnsub = null;

        this._renderCoalescer.cancel();
        Model.onIntentChange(null);
        Model.onWorldChange(null);
        Model.resetIntent();

        this._flyout?.destroy();
        this._flyout = null;

        for (const ctrl of this._controllers.values()) ctrl.destroy();
        this._controllers.clear();
        this._groupIcons.clear();

        this._ghost.clear();
        this._ghost = null;
        _instance = null;
        _settleWindow = null;

        this._scope.dispose();
        this._mainBox?.destroy();
        Main.panel.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        super.destroy();
    }
}

// ==================== TITLE BAR MOVE MONITOR ====================
export class TitleBarMoveMonitor {
    constructor() {
        this._currentDragWindow = null;
        this._lastSwitchedWorkspace = null;
        this._cursorTracker = global.backend.get_cursor_tracker();
        this._cursorPositionId = 0;

        this._beginId = Model.Display.connect('grab-op-begin',
            (display, window, op) => this._onGrabOpBegin(window, op));
        this._endId = Model.Display.connect('grab-op-end',
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
        Model.setIntent({ hintWs: null });
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
        Model.setIntent({ hintWs: null });

        if (!grabbed || grabbed !== window || !this._isMoveOp(op)) return;

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
        Model.setIntent({ hintWs: thumb ? thumb.index : null });
        if (!thumb) return;

        const ws = thumb.workspace;
        if (ws === Model.WorkspaceManager.get_active_workspace() || ws === this._lastSwitchedWorkspace) return;
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

    _moveWindowTo(thumb, window) {
        const ws = thumb.workspace;
        const alreadyThere = window.get_workspace() === ws;

        if (!alreadyThere) {
            Model.placeWindow(window, ws, null);
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
        if (this._beginId) { Model.Display.disconnect(this._beginId); this._beginId = null; }
        if (this._endId) { Model.Display.disconnect(this._endId); this._endId = null; }
        if (this._sessionModeId) { Main.sessionMode.disconnect(this._sessionModeId); this._sessionModeId = null; }
        this._currentDragWindow = null;
    }
}