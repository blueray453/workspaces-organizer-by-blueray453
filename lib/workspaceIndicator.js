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
// External (file/text) drag: pointer poll, dwell, activation.
const EXT_TICK_MS = 40;
const EXT_ACTIVATE_MS = 400;
const EXT_WS_DWELL_MS = 500;

const SLACK_PX = 32;
const MAX_SOLVE_STEPS = 6;

/* FIX #2 — the prototype shrank grouped icons to a hard 28–30 px because its
 * panel was 88 px tall with 64 px capsules. Mapped onto a configurable
 * `icon-size`, that ceiling was a 3x shrink and fired for any workspace with
 * more than DIRECT_MODE_MAX_WINDOWS windows. Now: the configured size is
 * authoritative, and shrinking is a last resort, one rung at a time, only
 * when the panel genuinely cannot fit the collapsed layout. */
const SIZE_LADDER = [1, 0.9, 0.78, 0.66, 0.55];
const SIZE_FLOOR = 20;

export function thumbnailAt(x, y) { return _instance?._thumbnailAt(x, y) ?? null; }
export function settleOnNextRender(window) { _settleWindow = window; }

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

        // Prototype's collapsedAppGroups — pressure-driven only.
        this._collapsed = new Set();
        this._denseStep = 0;

        this._scope = new Scheduling.Scope();
        this._renderCoalescer = new Scheduling.Coalescer(() => this._render());
        this._leavePollId = 0;

        this._dwellId = 0;
        this._dwellKey = null;

        // actor -> { shell, entry, group }
        this._groupIcons = new Map();

        this._flyout = new GroupFlyout(settings);

        // External drag state
        this._extPollId = 0;
        this._extRowKey = null;
        this._extRowTimer = 0;
        this._extWsKey = null;
        this._extWsTimer = 0;
        this._extActivated = false;
        this._extMaximized = null;
        this._extSawButton = false;

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

        if (!this._dragActive()) {
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
        if (externalDrag.active) return;   // freeze geometry while a file is in flight

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
                // Once an external drag is over the stage, XdndHandler also
                // calls this delegate (source = the XdndHandler). The poll in
                // _externalTick already handles workspace switching with a
                // dwell, so skip the immediate switch while it is running.
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

    /* FIX #2 */
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

    /**
     * Prototype renderWorkspaceIndicator(): render, measure, collapse the
     * largest groups until it fits, or expand the smallest collapsed ones
     * back while there is slack. Bounded so one pass can never spin.
     * FIX #2 — after grouping has done all it can, step the icon size down
     * the ladder instead of hard-coding a 30 px ceiling.
     */
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

        // FIX #2 — shrinking is the final resort, one rung per measurement.
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

        // `shell` (not just `entry`) is stored: it owns `strip` and `actor`.
        this._groupIcons.set(actor, { shell, entry, group });

        actor.connect('clicked', () => this._openGroupSelector(entry, group));

        // Internal window drags: keep the DND wiring, and dwell on the way.
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
        if (group.count < 2) return;
        if (this._flyout.isOpen && this._flyout.anchor === anchor) return;
        if (this._dwellKey === group.key) return;

        this._cancelDwell();
        this._dwellKey = group.key;
        this._dwellId = this._scope.timeout(DWELL_MS, () => {
            this._dwellId = 0;
            this._dwellKey = null;
            if (!this._dragActive()) return GLib.SOURCE_REMOVE;
            this._openFlyout(shell, group, anchor);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDwell() {
        if (this._dwellId) { this._scope.cancel(this._dwellId); this._dwellId = 0; }
        this._dwellKey = null;
    }

    _openFlyout(shell, group, anchor) {
        const { entry } = shell;
        shell.strip.cancel(); // drop the thumbnail ghost: the flyout takes over

        const items = group.windows.map((w, k) => ({
            window: w,
            index: group.indices[k],
            icon: UI.getWindowAppIcon(w),
            title: w.get_title() || 'Untitled Window',
            sub: `${group.appName}`.toUpperCase(),
            color: UI.colorForApp(group.appName),
        }));

        this._flyout.open({
            anchor,
            title: `${group.appName.toUpperCase()} · ${group.count} WINDOWS · WS ${entry.index + 1}`,
            items,
            onDrop: (source, item) => this._dropIntoGroup(shell, source, item),
        });
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

    // ==================== EXTERNAL DRAG (FIX #1 + #3) ====================
    _onExternalChanged(state) {
        if (state) {
            if (this._extPollId) return;   // already tracking this drag
            this._startExternalPoll();
        } else {
            this._stopExternalPoll(true);
        }
    }

    _startExternalPoll() {
        this._cancelDwell();
        this._flyout.close(true);

        this._extRowKey = null;
        this._extActivated = false;
        this._extMaximized = null;
        this._extSawButton = false;
        this._extWsKey = null;

        if (this._extPollId) return;
        this._extPollId = this._scope.timeout(EXT_TICK_MS, () => this._externalTick());
    }

    _stopExternalPoll(teardown) {
        if (this._extPollId) { this._scope.cancel(this._extPollId); this._extPollId = 0; }
        if (!teardown) return;

        this._cancelExtRow();
        this._cancelExtWorkspace();
        this._cancelDwell();
        this._flyout?.close(true);
        this._restoreExternalMaximize();

        this._extRowKey = null;
        this._extActivated = false;
        this._extWsKey = null;

        Model.setIntent({ hintWs: null });
        this._queueRender();
    }

    _externalTick() {
        if (!externalDrag.active) {
            this._extPollId = 0;
            this._stopExternalPoll(true);
            return GLib.SOURCE_REMOVE;
        }

        const [x, y, mods] = global.get_pointer();

        // Backstop only: some drag grabs report zero modifiers, so a
        // "released" reading is trusted only after a held reading.
        if (buttonHeld(mods)) this._extSawButton = true;
        else if (this._extSawButton) {
            // end() notifies _onExternalChanged(null), which tears down the
            // poll and cancels this source, so stop here.
            externalDrag.end('button-released');
            return GLib.SOURCE_REMOVE;
        }

        if (this._extActivated) return GLib.SOURCE_CONTINUE;

        // (1) Flyout is up — steer the row hover, which arms activation.
        if (this._flyout.isOpen) {
            const hit = this._flyout.pointerAt(x, y);
            if (hit?.item?.window) this._trackExternalRow(hit.item.window);
            else this._cancelExtRow();
            return GLib.SOURCE_CONTINUE;
        }

        // (2) A badged app group — dwell, then open the flyout.
        const group = this._groupIconAt(x, y);
        if (group) {
            this._dwellGroup(group.shell, group.group, group.actor);
            this._cancelExtRow();
            return GLib.SOURCE_CONTINUE;
        }

        // (3) A plain window icon — activate + maximize it after a dwell.
        const ctrl = this._windowIconAt(x, y);
        if (ctrl) {
            ctrl.notifyExternalDrag();
            this._cancelExtRow();
            this._cancelDwell();
            return GLib.SOURCE_CONTINUE;
        }

        // Pointer is not over a group icon or window icon: a pending
        // group dwell must not open a flyout the pointer already left.
        this._cancelDwell();

        // (4) A workspace thumbnail — switch to it after a dwell.
        this._maybeDwellWorkspace(x, y);
        return GLib.SOURCE_CONTINUE;
    }

    _trackExternalRow(win) {
        const key = String(win.get_id());
        if (this._extRowKey === key) return;

        this._extRowKey = key;
        this._cancelExtRowTimer();
        this._extRowTimer = this._scope.timeout(EXT_ACTIVATE_MS, () => {
            this._extRowTimer = 0;
            this._activateForExternalDrop(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelExtRow() {
        this._extRowKey = null;
        this._cancelExtRowTimer();
    }

    _cancelExtRowTimer() {
        if (this._extRowTimer) { this._scope.cancel(this._extRowTimer); this._extRowTimer = 0; }
    }

    /**
     * The prototype's reveal: bring the window forward at full size so the
     * foreign drag has somewhere obvious to land. We remember what we
     * maximized and undo it when the drag ends.
     */
    _activateForExternalDrop(win) {
        this._extActivated = true;
        this._flyout.close(true);
        this._cancelExtRow();

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
        } catch (e) {
            journal(`[WorkspaceIndicator] external activate failed: ${e.message}`);
        }
    }

    _restoreExternalMaximize() {
        const win = this._extMaximized;
        this._extMaximized = null;
        if (!win) return;
        try {
            if (win.get_maximized() === Meta.MaximizeFlags.BOTH)
                win.unmaximize(Meta.MaximizeFlags.BOTH);
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
    _actorHit(x, y, actor) {
        if (!actor || !actor.get_stage() || !actor.visible) return false;
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        return x >= ax && x <= ax + aw && y >= ay && y <= ay + ah;
    }

    _groupIconAt(x, y) {
        for (const [actor, info] of this._groupIcons) {
            if (this._actorHit(x, y, actor)) return { ...info, actor };
        }
        return null;
    }

    _windowIconAt(x, y) {
        for (const ctrl of this._controllers.values()) {
            if (this._actorHit(x, y, ctrl.actor)) return ctrl;
        }
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
            // Some drag grabs report zero modifiers, so an active external
            // drag counts as "held" instead of relying on BUTTON1_MASK.
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