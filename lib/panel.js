// ===== FILE: ./lib/panel.js =====
// Panel reorder / reposition / session-mode-layout edits, ported from
// fix-panel-order-by-blueray453. Uses this extension's Scope for signal cleanup.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Scope } from './scheduling.js';
import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const BOXES = ['left', 'center', 'right'];
const DELAY_MS = 100;
const HIDDEN_ROLES = new Set(['activities']);
const DATE_MENU = 'dateMenu';

export class PanelManager {
    constructor(settings) {
        this._settings = settings;
        this._scope = new Scope();
        this._positionScope = null;
        this._timeoutId = 0;

        this._modePanel = null;
        this._origPanelLayout = null;
        this._origFindDraggable = null;
        this._panelMoved = false;

        this._panelMoved = settings.get_boolean('move-panel-to-bottom');
        if (this._panelMoved) this._movePanelPosition(true);

        this._backupLayout();
        this._applyLayout();
        this._disablePanelWindowDrag(settings.get_boolean('disable-panel-window-drag'));

        for (const type of BOXES) {
            const box = Main.panel[`_${type}Box`];
            for (const sig of ['child-added', 'child-removed'])
                this._scope.connect(box, sig, () => this._schedule());
            this._scope.connect(settings, `changed::order-${type}`, () => this._sync());
        }

        this._scope.connect(settings, 'changed::move-panel-to-bottom',
            () => this._onPanelPositionChanged());
        this._scope.connect(settings, 'changed::hide-activities',
            () => this._applyLayout());
        this._scope.connect(settings, 'changed::date-menu-position',
            () => this._applyLayout());
        this._scope.connect(settings, 'changed::disable-panel-window-drag',
            () => this._disablePanelWindowDrag(
                this._settings.get_boolean('disable-panel-window-drag')));

        this._schedule();
    }

    destroy() {
        if (this._timeoutId) {
            try { GLib.Source.remove(this._timeoutId); } catch (e) { /* gone */ }
            this._timeoutId = 0;
        }
        this._scope.dispose();
        this._positionScope?.dispose();
        this._positionScope = null;

        if (this._panelMoved) {
            this._movePanelPosition(false);
            this._panelMoved = false;
        }
        this._restoreLayout();
        this._disablePanelWindowDrag(false);
        this._settings = null;
    }

    // ----- panel position -----
    _placePanel() {
        const { panelBox, primaryMonitor: m } = Main.layoutManager;
        if (!m) return;
        panelBox.set_position(m.x, m.y + m.height - panelBox.height);
    }

    _movePanelPosition(active) {
        this._positionScope?.dispose();
        this._positionScope = null;

        const lm = Main.layoutManager;
        if (active) {
            this._placePanel();
            this._positionScope = new Scope();
            this._positionScope.connect(lm, 'monitors-changed', () => this._placePanel());
            this._positionScope.connect(lm.panelBox, 'notify::height', () => this._placePanel());
        } else {
            const m = lm.primaryMonitor;
            if (m) lm.panelBox.set_position(m.x, m.y);
        }
    }

    _onPanelPositionChanged() {
        const should = this._settings.get_boolean('move-panel-to-bottom');
        if (should === this._panelMoved) return;
        this._movePanelPosition(should);
        this._panelMoved = should;
    }

    // ----- session-mode layout -----
    _backupLayout() {
        if (this._modePanel) return;
        const panel = Main.sessionMode.panel;
        this._modePanel = panel;
        this._origPanelLayout = {
            left: [...panel.left],
            center: [...panel.center],
            right: [...panel.right],
        };
    }

    _restoreLayout() {
        if (!this._modePanel) return;
        Object.assign(this._modePanel, this._origPanelLayout);
        this._modePanel = null;
        this._origPanelLayout = null;
        Main.panel._updatePanel();
    }

    _applyLayout() {
        if (!this._modePanel) return;
        this._modePanel.left = [...this._origPanelLayout.left];
        this._modePanel.center = [...this._origPanelLayout.center];
        this._modePanel.right = [...this._origPanelLayout.right];

        if (this._settings.get_boolean('hide-activities'))
            this._hideActivities();
        this._applyDateMenuPosition();

        Main.panel._updatePanel();
    }

    _hideActivities() {
        const panel = this._modePanel;
        for (const box of BOXES)
            panel[box] = panel[box].filter(role => !HIDDEN_ROLES.has(role));
    }

    _applyDateMenuPosition() {
        const choice = this._settings.get_string('date-menu-position');
        if (choice === 'stock') return;
        const panel = this._modePanel;
        for (const box of BOXES)
            panel[box] = panel[box].filter(role => role !== DATE_MENU);
        if (choice === 'left-first') panel.left = [DATE_MENU, ...panel.left];
        else if (choice === 'center-first') panel.center = [DATE_MENU, ...panel.center];
        else if (choice === 'right-first') panel.right = [DATE_MENU, ...panel.right];
    }

    // ----- disable panel window drag -----
    _disablePanelWindowDrag(active) {
        const panel = Main.panel;
        if (active) {
            if (this._origFindDraggable) return;
            this._origFindDraggable = panel._getDraggableWindowForPosition;
            panel._getDraggableWindowForPosition = () => null;
        } else if (this._origFindDraggable) {
            panel._getDraggableWindowForPosition = this._origFindDraggable;
            this._origFindDraggable = null;
        }
    }

    // ----- indicator order -----
    _schedule() {
        if (this._timeoutId) return;
        this._timeoutId = this._scope.timeout(DELAY_MS, () => {
            this._timeoutId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        if (!this._settings) return;
        const area = Main.panel.statusArea;
        const roleOf = new Map(
            Object.entries(area)
                .filter(([role]) => !HIDDEN_ROLES.has(role))
                .map(([role, ind]) => [ind?.container, role]));

        for (const type of BOXES) {
            const box = Main.panel[`_${type}Box`];

            let index = 0;
            for (const role of this._settings.get_strv(`order-${type}`)) {
                const actor = area[role]?.container;
                if (actor?.get_parent() === box)
                    box.set_child_at_index(actor, index++);
            }

            const roles = box.get_children().map(c => roleOf.get(c)).filter(Boolean);
            const key = `discovered-${type}`;
            if (roles.join('\n') !== this._settings.get_strv(key).join('\n'))
                this._settings.set_strv(key, roles);
        }
    }
}