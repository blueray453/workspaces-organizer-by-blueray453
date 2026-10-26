import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const NUMERIC_KEYS = [
    { key: 'base-size', label: 'UI base size', min: 16, max: 96, step: 2 },
    { key: 'glass-strength', label: 'Transparency strength (%)', min: 0, max: 150, step: 5 },
    { key: 'thumbnail-min-width', label: 'Thumbnail minimum width', min: 20, max: 200, step: 2 },
    { key: 'overlay-max-aspect', label: 'Window selector max aspect ratio (16:9 ≈ 1.78)', min: 1.0, max: 3.0, step: 0.05 },
    { key: 'flyout-dwell-ms', label: 'Flyout dwell (ms)', min: 0, max: 1500, step: 10 },
    { key: 'ext-ws-dwell-ms', label: 'External-drag workspace dwell (ms)', min: 0, max: 2000, step: 50 },
];

const BOOLEAN_KEYS = [
    ['show-window-button', 'Show "all windows" button'],
    ['show-workspace-names', 'Show workspace names'],
];

const BOXES = [['left', 'Left Box'], ['center', 'Center Box'], ['right', 'Right Box']];

const DATE_CHOICES = ['stock', 'left-first', 'center-first', 'right-first'];
const DATE_LABELS = [
    'Stock (shell default)',
    'Left box, first',
    'Center box, first',
    'Right box, first',
];

export default class WorkspacesOrganizerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'preferences-desktop-font-symbolic',
        });
        window.add(page);

        const byKey = key => NUMERIC_KEYS.find(k => k.key === key);

        // Size
        const sizeGroup = new Adw.PreferencesGroup({
            title: 'Size',
            description: 'Every text and icon size scales from the base value',
        });
        page.add(sizeGroup);
        ['base-size', 'thumbnail-min-width', 'overlay-max-aspect'].forEach(k =>
            this._addSpinRow(sizeGroup, byKey(k), settings));

        // Appearance
        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Surface transparency (100% = designed look)',
        });
        page.add(appearanceGroup);
        this._addSpinRow(appearanceGroup, byKey('glass-strength'), settings);

        // Panel elements
        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel',
            description: 'Toggle panel elements — changes apply immediately',
        });
        page.add(panelGroup);
        for (const [key, title] of BOOLEAN_KEYS) {
            const row = new Adw.ActionRow({ title });
            const toggle = new Gtk.Switch({ valign: Gtk.Align.CENTER });
            settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
            row.add_suffix(toggle);
            row.set_activatable_widget(toggle);
            panelGroup.add(row);
        }

        // Timing
        const timingGroup = new Adw.PreferencesGroup({
            title: 'Timing',
            description: 'Interaction delays in milliseconds (0 = fire as soon as the pointer rests)',
        });
        page.add(timingGroup);
        ['flyout-dwell-ms', 'ext-ws-dwell-ms'].forEach(k =>
            this._addSpinRow(timingGroup, byKey(k), settings));

        // Accessibility
        const accessGroup = new Adw.PreferencesGroup({ title: 'Accessibility' });
        page.add(accessGroup);
        const reduceRow = new Adw.ActionRow({
            title: 'Reduce motion',
            subtitle: 'Disable fade, settle and flyout animations.',
        });
        const reduceToggle = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('reduce-motion', reduceToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        reduceRow.add_suffix(reduceToggle);
        reduceRow.set_activatable_widget(reduceToggle);
        accessGroup.add(reduceRow);

        // Misc
        const miscGroup = new Adw.PreferencesGroup();
        page.add(miscGroup);

        const resetRow = new Adw.ActionRow({ title: 'Reset all settings to defaults' });
        const resetBtn = new Gtk.Button({ label: 'Reset', css_classes: ['destructive-action'] });
        resetBtn.connect('clicked', () => {
            for (const key of settings.list_keys()) {
                try { settings.reset(key); } catch (e) { /* skip */ }
            }
        });
        resetRow.add_suffix(resetBtn);
        resetRow.set_activatable_widget(resetBtn);
        miscGroup.add(resetRow);

        miscGroup.add(new Adw.ActionRow({
            title: 'Changes apply immediately',
            subtitle: 'The panel re-renders on the next window/workspace change — usually within a second.',
        }));

        // Panel ordering page
        this._addPanelPage(window, settings);
    }

    // ==================== Panel ordering page ====================
    _addPanelPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Panel Order',
            icon_name: 'view-list-symbolic',
        });
        window.add(page);

        const css = new Gtk.CssProvider();
        css.load_from_string(`
            row.drop-before { box-shadow: inset 0 2px 0 0 @accent_color; }
            row.drop-after  { box-shadow: inset 0 -2px 0 0 @accent_color; }
            row.dragging    { opacity: 0.4; }
        `);
        const display = Gdk.Display.get_default();
        Gtk.StyleContext.add_provider_for_display(
            display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        let dragged = null;
        const cleanups = [];
        cleanups.push(() => {
            try {
                Gtk.StyleContext.remove_provider_for_display(display, css);
            } catch (e) { /* gone */ }
        });

        // ---- Behaviour ----
        const behaviour = new Adw.PreferencesGroup({
            title: 'Behaviour',
            description: 'Applied immediately — no restart needed.',
        });
        page.add(behaviour);

        behaviour.add(this._booleanRow(settings,
            'move-panel-to-bottom',
            'Move panel to bottom',
            'Move the top bar to the bottom of the screen. Ordering still applies.'));

        behaviour.add(this._booleanRow(settings,
            'hide-activities',
            'Hide Activities button',
            'Remove Activities from the panel layout.'));

        behaviour.add(this._booleanRow(settings,
            'disable-panel-window-drag',
            'Disable panel window drag',
            'Stop pressing the panel from starting a drag on the maximized window behind it.'));

        behaviour.add(this._comboRow(settings,
            'date-menu-position',
            'Date menu position',
            'Where to move the date/clock menu.',
            DATE_CHOICES, DATE_LABELS, cleanups));

        // ---- Per-box ordering ----
        for (const [type, title] of BOXES) {
            const orderKey = `order-${type}`;
            const discKey = `discovered-${type}`;
            const group = new Adw.PreferencesGroup({ title });
            const list = new Gtk.ListBox({
                selection_mode: Gtk.SelectionMode.NONE,
                css_classes: ['boxed-list'],
            });
            group.add(list);
            page.add(group);

            const shownOrder = () => {
                const present = settings.get_strv(discKey);
                const saved = settings.get_strv(orderKey).filter(r => present.includes(r));
                return [...new Set([...saved, ...present])];
            };

            const persist = shown => {
                if (settings.get_strv(discKey).length === 0) return;
                const raw = settings.get_strv(orderKey);
                const queue = [...shown];
                const next = [...new Set(raw)]
                    .map(r => shown.includes(r) ? queue.shift() : r)
                    .concat(queue);
                if (next.join('\n') !== raw.join('\n'))
                    settings.set_strv(orderKey, next);
            };

            let marked = null;
            const clearMark = () => {
                marked?.remove_css_class('drop-before');
                marked?.remove_css_class('drop-after');
                marked = null;
            };

            const locate = y => {
                const row = list.get_row_at_y(y);
                if (row) return { row, after: y > row.get_allocation().y + row.get_height() / 2 };
                return { row: list.get_last_child(), after: true };
            };

            const valid = row => dragged?.type === type && row?._role && row._role !== dragged.role;

            const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
            drop.connect('motion', (_t, _x, y) => {
                const { row, after } = locate(y);
                clearMark();
                if (!valid(row)) return 0;
                row.add_css_class(after ? 'drop-after' : 'drop-before');
                marked = row;
                return Gdk.DragAction.MOVE;
            });
            drop.connect('leave', clearMark);
            drop.connect('drop', (_t, _v, _x, y) => {
                clearMark();
                const { row, after } = locate(y);
                if (!valid(row)) return false;
                const shown = shownOrder().filter(r => r !== dragged.role);
                shown.splice(shown.indexOf(row._role) + (after ? 1 : 0), 0, dragged.role);
                persist(shown);
                rebuild(shown);
                return true;
            });
            list.add_controller(drop);

            const addRow = role => {
                const row = new Adw.ActionRow({ title: role });
                row._role = role;
                row.add_prefix(new Gtk.Image({ icon_name: 'list-drag-handle-symbolic' }));

                const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
                source.connect('prepare', () => {
                    const value = new GObject.Value();
                    value.init(GObject.TYPE_STRING);
                    value.set_string(role);
                    return Gdk.ContentProvider.new_for_value(value);
                });
                source.connect('drag-begin', src => {
                    dragged = { type, role };
                    row.add_css_class('dragging');
                    src.set_icon(new Gtk.WidgetPaintable({ widget: row }),
                        row.get_width() / 2, row.get_height() / 2);
                });
                source.connect('drag-end', () => {
                    dragged = null;
                    row.remove_css_class('dragging');
                    clearMark();
                });
                row.add_controller(source);

                list.append(row);
            };

            const rebuild = (shown = shownOrder()) => {
                list.remove_all();
                marked = null;
                if (shown.length)
                    shown.forEach(addRow);
                else
                    list.append(new Adw.ActionRow({
                        title: 'No indicators found here',
                        sensitive: false,
                    }));
                persist(shown);
            };

            const id = settings.connect(`changed::${discKey}`, () => rebuild());
            cleanups.push(() => settings.disconnect(id));
            rebuild();
        }

        // ---- Reset orders ----
        const miscGroup = new Adw.PreferencesGroup();
        page.add(miscGroup);

        const resetRow = new Adw.ActionRow({
            title: 'Reset panel orders to defaults',
            subtitle: 'Behaviour toggles above are not affected.',
        });
        const resetBtn = new Gtk.Button({
            label: 'Reset',
            css_classes: ['destructive-action'],
        });
        resetBtn.connect('clicked', () => {
            for (const [type] of BOXES) settings.reset(`order-${type}`);
        });
        resetRow.add_suffix(resetBtn);
        resetRow.set_activatable_widget(resetBtn);
        miscGroup.add(resetRow);

        window.connect('close-request', () => {
            cleanups.forEach(fn => fn());
            return false;
        });
    }

    // ---------- helpers ----------
    _addSpinRow(group, { key, label, min, max, step }, settings) {
        const row = new Adw.ActionRow({ title: label });
        const spin = Gtk.SpinButton.new_with_range(min, max, step);
        settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(spin);
        row.set_activatable_widget(spin);
        group.add(row);
    }

    _booleanRow(settings, key, title, subtitle) {
        const row = new Adw.ActionRow({ title, subtitle });
        const toggle = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(toggle);
        row.set_activatable_widget(toggle);
        return row;
    }

    _comboRow(settings, key, title, subtitle, choices, labels, cleanups) {
        const row = new Adw.ComboRow({
            title, subtitle,
            model: new Gtk.StringList({ strings: labels }),
        });

        const sync = () => {
            const v = settings.get_string(key);
            const i = choices.indexOf(v);
            if (i >= 0 && row.selected !== i) row.selected = i;
        };
        row.connect('notify::selected', () => {
            const v = choices[row.selected];
            if (v && settings.get_string(key) !== v) settings.set_string(key, v);
        });

        const id = settings.connect(`changed::${key}`, sync);
        cleanups.push(() => settings.disconnect(id));
        sync();
        return row;
    }
}