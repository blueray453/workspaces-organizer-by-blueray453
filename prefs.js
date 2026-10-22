import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const NUMERIC_KEYS = [
    { key: 'base-size', label: 'UI base size', min: 16, max: 96, step: 2 },
    { key: 'glass-strength', label: 'Transparency strength (%)', min: 0, max: 150, step: 5 },
    { key: 'thumbnail-min-width', label: 'Thumbnail minimum width', min: 20, max: 200, step: 2 },
    { key: 'direct-mode-max-windows', label: 'Auto-group above N windows', min: 1, max: 20, step: 1 },
    { key: 'flyout-dwell-ms', label: 'Flyout dwell', min: 50, max: 1500, step: 10 },
    { key: 'ext-ws-dwell-ms', label: 'External-drag workspace dwell', min: 100, max: 2000, step: 50 },
];

const BOOLEAN_KEYS = [
    ['show-window-button', 'Show "all windows" button'],
    ['show-workspace-names', 'Show workspace names'],
    ['group-apps-always', 'Always group windows by app'],
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

        // Size — one knob scales the whole UI
        const sizeGroup = new Adw.PreferencesGroup({
            title: 'Size',
            description: 'Every text and icon size scales from the base value',
        });
        page.add(sizeGroup);
        ['base-size', 'thumbnail-min-width'].forEach(k =>
            this._addSpinRow(sizeGroup, byKey(k), settings));

        // Appearance — glass strength
        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Surface transparency (100% = designed look)',
        });
        page.add(appearanceGroup);
        this._addSpinRow(appearanceGroup, byKey('glass-strength'), settings);

        // Panel
        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel',
            description: 'Toggle panel elements — changes apply immediately',
        });
        page.add(panelGroup);
        for (const [key, title] of BOOLEAN_KEYS) {
            const row = new Adw.ActionRow({ title });
            if (key === 'group-apps-always') {
                row.set_subtitle(
                    'Off: group only when the panel runs out of room. ' +
                    'On: every app with 2+ windows collapses into one badged icon.');
            }
            const toggle = new Gtk.Switch({ valign: Gtk.Align.CENTER });
            settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
            row.add_suffix(toggle);
            row.set_activatable_widget(toggle);
            panelGroup.add(row);
        }

        // Grouping
        const groupingGroup = new Adw.PreferencesGroup({
            title: 'Grouping',
            description: 'When multiple windows of the same app collapse',
        });
        page.add(groupingGroup);
        this._addSpinRow(groupingGroup, byKey('direct-mode-max-windows'), settings);

        // Timing
        const timingGroup = new Adw.PreferencesGroup({
            title: 'Timing',
            description: 'Interaction delays (milliseconds)',
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
    }

    _addSpinRow(group, { key, label, min, max, step }, settings) {
        const row = new Adw.ActionRow({ title: label });
        const spin = Gtk.SpinButton.new_with_range(min, max, step);
        settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(spin);
        row.set_activatable_widget(spin);
        group.add(row);
    }
}