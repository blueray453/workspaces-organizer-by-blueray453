import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WorkspacesOrganizerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'preferences-desktop-font-symbolic',
        });
        window.add(page);

        // Define all configuration keys (only one icon-size now)
        const allKeys = [
            { key: 'icon-size', label: 'Icon size', min: 16, max: 256, step: 2 },
            { key: 'thumbnail-min-width', label: 'Thumbnail minimum width', min: 20, max: 200, step: 2 },
            { key: 'workspace-name-font-size', label: 'Workspace name', min: 10, max: 100, step: 1 },
            { key: 'toolbar-icon-size', label: 'Panel toolbar icon size', min: 16, max: 64, step: 2 },
            { key: 'title-popup-font-size', label: 'Title popup (Ctrl+hold)', min: 8, max: 48, step: 1 },
            { key: 'collection-search-font-size', label: 'Collection search entry', min: 8, max: 48, step: 1 },
            { key: 'collection-result-font-size', label: 'Collection result items', min: 8, max: 48, step: 1 },
            { key: 'collection-result-icon-size', label: 'Search result icon size', min: 16, max: 128, step: 2 },
            { key: 'clone-title-font-size', label: 'Clone preview title', min: 10, max: 80, step: 1 },
            { key: 'hover-preview-height', label: 'Hover preview height', min: 200, max: 1200, step: 10 },
            { key: 'close-button-size', label: 'Close button size', min: 16, max: 64, step: 2 },
            { key: 'app-preview-icon-size', label: 'App search preview icon size', min: 32, max: 256, step: 2 },
            { key: 'tooltip-font-size', label: 'Tooltip text', min: 6, max: 32, step: 1 },
        ];

        // Group: Icon Sizes (now just one row)
        const iconGroup = new Adw.PreferencesGroup({
            title: 'Icon Sizes',
            description: 'Size of window icons in workspace thumbnails',
        });
        page.add(iconGroup);
        this._addSpinRow(iconGroup, allKeys.find(k => k.key === 'icon-size'), settings);
        this._addSpinRow(iconGroup, allKeys.find(k => k.key === 'app-preview-icon-size'), settings);


        // Group: Font Sizes
        const fontGroup = new Adw.PreferencesGroup({
            title: 'Font Sizes',
            description: 'Text size in various UI elements',
        });
        page.add(fontGroup);
        ['workspace-name-font-size', 'title-popup-font-size',
            'collection-search-font-size', 'collection-result-font-size', 'collection-result-icon-size',
            'clone-title-font-size', 'tooltip-font-size'].forEach(key => {
                const def = allKeys.find(k => k.key === key);
                this._addSpinRow(fontGroup, def, settings);
            });

        // Group: Layout
        const layoutGroup = new Adw.PreferencesGroup({
            title: 'Layout',
            description: 'Sizes and dimensions',
        });
        page.add(layoutGroup);
        ['thumbnail-min-width', 'toolbar-icon-size', 'hover-preview-height', 'close-button-size'].forEach(key => {
            const def = allKeys.find(k => k.key === key);
            this._addSpinRow(layoutGroup, def, settings);
        });

        const visibilityGroup = new Adw.PreferencesGroup({
            title: 'Visibility',
            description: 'Toggle panel elements — changes apply immediately, no restart needed',
        });
        page.add(visibilityGroup);

        for (const [key, title] of [
            ['show-drun-button', 'Show "apps" button'],
            ['show-window-button', 'Show "all windows" button'],
            ['show-workspace-names', 'Show workspace names'],
        ]) {
            const row = new Adw.ActionRow({ title });
            const toggle = new Gtk.Switch({ valign: Gtk.Align.CENTER });
            settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
            row.add_suffix(toggle);
            row.set_activatable_widget(toggle);
            visibilityGroup.add(row);
        }

        // Group: Reset and notes
        const miscGroup = new Adw.PreferencesGroup();
        page.add(miscGroup);

        // Reset button
        const resetRow = new Adw.ActionRow({ title: 'Reset all settings to defaults' });
        const resetBtn = new Gtk.Button({
            label: 'Reset',
            css_classes: ['destructive-action'],
        });
        resetBtn.connect('clicked', () => {
            for (const { key } of allKeys) {
                settings.reset(key);
            }
            // Window stays open – spin buttons update automatically
        });
        resetRow.add_suffix(resetBtn);
        resetRow.set_activatable_widget(resetBtn);
        miscGroup.add(resetRow);

        const note = new Adw.ActionRow({
            title: 'Changes take effect after restarting the extension (disable & enable).',
            subtitle: 'You may need to reload GNOME Shell (Alt+F2, r) for some changes.',
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
