import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const NUMERIC_KEYS = [
    { key: 'icon-size', label: 'Icon size', min: 16, max: 256, step: 2 },
    { key: 'thumbnail-min-width', label: 'Thumbnail minimum width', min: 20, max: 200, step: 2 },
    { key: 'workspace-name-font-size', label: 'Workspace name', min: 10, max: 100, step: 1 },
    { key: 'toolbar-icon-size', label: 'Panel toolbar icon size', min: 16, max: 64, step: 2 },
    { key: 'hover-preview-height', label: 'Hover preview height', min: 200, max: 1200, step: 10 },
    { key: 'close-button-size', label: 'Close button size', min: 16, max: 64, step: 2 },
    { key: 'tooltip-font-size', label: 'Tooltip text', min: 6, max: 32, step: 1 },
    { key: 'direct-mode-max-windows', label: 'Auto-group above N windows', min: 1, max: 20, step: 1 },
    { key: 'flyout-dwell-ms', label: 'Flyout dwell', min: 50, max: 1500, step: 10 },
    { key: 'ext-ws-dwell-ms', label: 'External-drag workspace dwell', min: 100, max: 2000, step: 50 },
];

const BOOLEAN_KEYS = [
    ['show-drun-button', 'Show "apps" button'],
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

        // Icon Sizes
        const iconGroup = new Adw.PreferencesGroup({
            title: 'Icon Sizes',
            description: 'Size of window icons in workspace thumbnails',
        });
        page.add(iconGroup);
        this._addSpinRow(iconGroup, byKey('icon-size'), settings);

        // Font Sizes
        const fontGroup = new Adw.PreferencesGroup({
            title: 'Font Sizes',
            description: 'Text size in various UI elements',
        });
        page.add(fontGroup);
        ['workspace-name-font-size', 'tooltip-font-size'].forEach(key => {
            this._addSpinRow(fontGroup, byKey(key), settings);
        });

        // Layout
        const layoutGroup = new Adw.PreferencesGroup({
            title: 'Layout',
            description: 'Sizes and dimensions',
        });
        page.add(layoutGroup);
        ['thumbnail-min-width', 'toolbar-icon-size', 'hover-preview-height', 'close-button-size'].forEach(key => {
            this._addSpinRow(layoutGroup, byKey(key), settings);
        });

        // Panel
        const visibilityGroup = new Adw.PreferencesGroup({
            title: 'Panel',
            description: 'Toggle panel elements — changes apply immediately, no restart needed',
        });
        page.add(visibilityGroup);
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
            visibilityGroup.add(row);
        }

        // Grouping
        const groupingGroup = new Adw.PreferencesGroup({
            title: 'Grouping',
            description: 'When multiple windows of the same app collapse into one badged icon',
        });
        page.add(groupingGroup);
        this._addSpinRow(groupingGroup, byKey('direct-mode-max-windows'), settings);

        // Timing
        const timingGroup = new Adw.PreferencesGroup({
            title: 'Timing',
            description: 'Interaction delays (milliseconds)',
        });
        page.add(timingGroup);
        ['flyout-dwell-ms', 'ext-ws-dwell-ms'].forEach(key => {
            this._addSpinRow(timingGroup, byKey(key), settings);
        });

        // Accessibility
        const accessGroup = new Adw.PreferencesGroup({
            title: 'Accessibility',
        });
        page.add(accessGroup);

        const reduceRow = new Adw.ActionRow({
            title: 'Reduce motion',
            subtitle: 'Disable fade, settle and flyout animations. Layout changes snap instantly.',
        });
        const reduceToggle = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('reduce-motion', reduceToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        reduceRow.add_suffix(reduceToggle);
        reduceRow.set_activatable_widget(reduceToggle);
        accessGroup.add(reduceRow);

        // Misc — reset / notes
        const miscGroup = new Adw.PreferencesGroup();
        page.add(miscGroup);

        const resetRow = new Adw.ActionRow({ title: 'Reset all settings to defaults' });
        const resetBtn = new Gtk.Button({
            label: 'Reset',
            css_classes: ['destructive-action'],
        });
        resetBtn.connect('clicked', () => {
            for (const key of settings.list_keys()) {
                try { settings.reset(key); }
                catch (e) { /* non-resettable key, skip */ }
            }
        });
        resetRow.add_suffix(resetBtn);
        resetRow.set_activatable_widget(resetBtn);
        miscGroup.add(resetRow);

        const note = new Adw.ActionRow({
            title: 'Changes apply immediately',
            subtitle: 'The panel re-renders on the next window/workspace change — usually within a second.',
        });
        miscGroup.add(note);
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