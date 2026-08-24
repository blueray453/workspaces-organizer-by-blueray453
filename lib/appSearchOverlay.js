import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import { fuzzyMatch } from './fuzzyMatch.js';

import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

// ==================== APP SEARCH OVERLAY ====================
// Fullscreen app launcher, structurally mirrored on WindowSearchOverlay
// (same entry/results/preview layout, same key handling, same fuzzy
// matcher) but browsing Shell.App instead of Meta.Window. Apps have no
// live compositor texture to clone, so the right-hand panel shows a large
// static icon + description instead, and adds pin/unpin + app actions
// since those only make sense for apps, not open windows.
export class AppSearchOverlay {
    constructor(settings) {
        this._settings = settings;
        this._favorites = AppFavorites.getAppFavorites();
        this._results = [];
        this._resultButtons = [];
        this._selectedIndex = -1;
        this._modalGrab = null;
        this._closed = false;
        this._buildUI();
        this._setResults(this._getAllResultsSorted());
        this._open();
    }

    _getAllApps() {
        const appSystem = Shell.AppSystem.get_default();
        let appInfos = [];

        // Try Shell.AppSystem first
        if (appSystem && typeof appSystem.get_all === 'function') {
            try {
                appInfos = appSystem.get_all().filter(app => {
                    try { return app.should_show(); } catch { return false; }
                });
            } catch (e) {
                journal(`[AppSearchOverlay] Shell.AppSystem.get_all() failed: ${e.message}`);
            }
        }

        // Fallback to Gio.AppInfo if the above didn't work
        if (appInfos.length === 0) {
            try {
                appInfos = Gio.AppInfo.get_all().filter(app => {
                    try { return app.should_show(); } catch { return false; }
                });
                // Convert Gio.AppInfo to Shell.App if possible
                const shellApps = [];
                for (const info of appInfos) {
                    let shellApp = null;
                    if (appSystem && typeof appSystem.lookup_app === 'function') {
                        try {
                            shellApp = appSystem.lookup_app(info.get_id());
                        } catch (e) {
                            // Ignore
                        }
                    }
                    // If we have a Shell.App, use it; otherwise, use the Gio.AppInfo directly
                    shellApps.push(shellApp || info);
                }
                return shellApps;
            } catch (e) {
                journal(`[AppSearchOverlay] Gio.AppInfo fallback failed: ${e.message}`);
                return [];
            }
        }

        return appInfos;
    }

    _getAllResultsSorted() {
        journal(`[AppSearchOverlay] _getAllResultsSorted start`);
        try {
            const apps = this._getAllApps();
            if (!apps || apps.length === 0) {
                journal('[AppSearchOverlay] No apps found');
                return [];
            }
            journal(`[AppSearchOverlay] apps count: ${apps.length}`);

            // Build favorite IDs safely (only Shell.App have get_id)
            const favorites = this._favorites.getFavorites();
            const favoriteIds = new Set();
            for (const fav of favorites) {
                try {
                    const id = fav.get_id();
                    if (id) favoriteIds.add(id);
                } catch (e) {
                    journal(`[AppSearchOverlay] Fav error: ${e.message}`);
                }
            }
            journal(`[AppSearchOverlay] favoriteIds size: ${favoriteIds.size}`);

            const items = [];
            for (const app of apps) {
                try {
                    // Handle both Shell.App and Gio.AppInfo
                    let id, name, icon;
                    if (typeof app.get_id === 'function') {
                        id = app.get_id();
                    } else if (typeof app.get_id === 'function') { // already covered
                        id = app.get_id();
                    } else {
                        // fallback: use the app object's toString or something
                        id = String(app);
                    }
                    if (!id) continue;

                    if (typeof app.get_name === 'function') {
                        name = app.get_name() || '';
                    } else {
                        name = String(app) || '';
                    }

                    if (typeof app.get_icon === 'function') {
                        icon = app.get_icon() || null;
                    } else {
                        icon = null;
                    }

                    items.push({
                        app,               // keep original (Shell.App or Gio.AppInfo)
                        name,
                        icon,
                        pinned: favoriteIds.has(id),
                    });
                } catch (e) {
                    journal(`[AppSearchOverlay] Skipping app: ${e.message}`);
                }
            }

            items.sort((a, b) => a.name.localeCompare(b.name));
            journal(`[AppSearchOverlay] Sorted Results ${items.length} apps`);
            return items;
        } catch (e) {
            journal(`[AppSearchOverlay] CRITICAL ERROR: ${e.message}\n${e.stack}`);
            return [];
        }
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        this._container = new St.Widget({
            style_class: 'window-collection-overlay',
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });

        const margin = 40;
        const entryHeight = 60;
        const entryGap = 20;
        const panelWidth = monitor.width - margin * 2;
        const panelX = monitor.x + margin;
        const entryY = monitor.y + margin;
        const panelTop = entryY + entryHeight + entryGap;
        const panelHeight = monitor.height - (panelTop - monitor.y) - margin;
        const resultsWidth = Math.round(panelWidth * 0.32);
        const previewWidth = panelWidth - resultsWidth - 20;

        this._entry = new St.Entry({
            style_class: 'collection-search-entry',
            hint_text: 'Search apps… (Ctrl+P: pin/unpin)',
            can_focus: true,
            x: panelX,
            y: entryY,
            width: panelWidth,
            height: entryHeight,
        });
        this._entry.set_style(`font-size: ${this._settings.get_int('collection-search-font-size')}pt;`);

        this._resultsScroll = new St.ScrollView({
            style_class: 'collection-results-scroll',
            x: panelX,
            y: panelTop,
            width: resultsWidth,
            height: panelHeight,
        });
        this._resultsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        this._resultsBox = new St.BoxLayout({
            style_class: 'collection-results-box',
            vertical: true,
            x_expand: true,
        });
        this._resultsScroll.set_child(this._resultsBox);

        this._previewBox = new St.BoxLayout({
            style_class: 'collection-preview-box',
            vertical: true,
            x: panelX + resultsWidth + 20,
            y: panelTop,
            width: previewWidth,
            height: panelHeight,
        });

        this._container.add_child(this._entry);
        this._container.add_child(this._resultsScroll);
        this._container.add_child(this._previewBox);

        this._entryChangedId = this._entry.clutter_text.connect('text-changed',
            () => this._onSearchChanged());
        this._entryKeyPressId = this._entry.clutter_text.connect('key-press-event',
            (actor, event) => this._onKeyPress(event));

        this._favoritesChangedId = this._favorites.connect('changed', () => this._onFavoritesChanged());

        journal(`[AppSearchOverlay] Build UI End`);
    }

    _open() {
        Main.layoutManager.addChrome(this._container, {
            affectsInputRegion: true,
            trackFullscreen: true,
        });
        Main.layoutManager.uiGroup.set_child_above_sibling(this._container, null);
        this._modalGrab = Main.pushModal(this._container, {
            actionMode: Shell.ActionMode.NORMAL,
        });
        this._entry.grab_key_focus();
    }

    _close() {
        if (this._closed) return;
        this._closed = true;
        journal(`[AppSearchOverlay] Closing`);
        this._clearPreview();
        if (this._modalGrab) {
            Main.popModal(this._modalGrab);
            this._modalGrab = null;
        }
        if (this._entry?.clutter_text) {
            this._entry.clutter_text.disconnect(this._entryChangedId);
            this._entry.clutter_text.disconnect(this._entryKeyPressId);
        }
        if (this._favoritesChangedId) {
            this._favorites.disconnect(this._favoritesChangedId);
            this._favoritesChangedId = null;
        }
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
    }

    _onFavoritesChanged() {
        if (this._closed) return;
        // Re-run current query so pin markers refresh without losing
        // whatever the person has typed.
        this._onSearchChanged();
    }

    _onSearchChanged() {
        if (this._closed) return;
        const query = this._entry.get_text();
        const all = this._getAllResultsSorted();
        if (!query.trim()) {
            this._setResults(all);
            return;
        }
        const scored = [];
        for (const item of all) {
            const result = fuzzyMatch(query, item.name);
            if (result.matched)
                scored.push({ ...item, score: result.score });
        }
        scored.sort((a, b) => b.score - a.score);
        this._setResults(scored);
    }

    _setResults(results) {
        journal(`[AppSearchOverlay] Set Results Start`);
        const previousAppId = this._results[this._selectedIndex]?.app.get_id();
        this._results = results;
        this._resultsBox.destroy_all_children();
        this._resultButtons = [];
        this._selectedIndex = -1;

        results.forEach((item, index) => {
            const button = new St.Button({
                style_class: 'collection-result-item',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                track_hover: true,
                reactive: true,
            });
            button.set_style(`font-size: ${this._settings.get_int('collection-result-font-size')}pt;`);

            const row = new St.BoxLayout({ vertical: false, x_expand: true });

            const iconSize = this._settings.get_int('collection-result-icon-size');
            if (item.icon) {
                row.add_child(new St.Icon({
                    gicon: item.icon,
                    style_class: 'collection-result-icon',
                    icon_size: iconSize,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            row.add_child(new St.Label({
                text: item.name,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            if (item.pinned) {
                row.add_child(new St.Label({
                    text: '📌',
                    style_class: 'app-pin-marker',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            button.set_child(row);

            button.connect('clicked', () => this._activateResult(index));
            button.connect('notify::hover', () => {
                if (button.hover)
                    this._selectIndex(index);
            });

            this._resultsBox.add_child(button);
            this._resultButtons.push(button);
        });

        if (results.length === 0) {
            this._clearPreview();
            return;
        }

        // Preserve selection across a favorites-triggered refresh instead
        // of always snapping back to index 0.
        const restoredIndex = previousAppId
            ? results.findIndex(item => item.app.get_id() === previousAppId)
            : -1;
        this._selectIndex(restoredIndex >= 0 ? restoredIndex : 0);
    }

    _selectIndex(index) {
        if (this._closed) return;
        if (index < 0 || index >= this._results.length)
            return;
        if (this._selectedIndex >= 0 && this._resultButtons[this._selectedIndex])
            this._resultButtons[this._selectedIndex].remove_style_class_name('selected');
        this._selectedIndex = index;
        this._resultButtons[index]?.add_style_class_name('selected');
        this._updatePreview(this._results[index]);
    }

    _updatePreview(item) {
        this._clearPreview();
        const { app } = item;

        const wrapper = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const largeIconSize = this._settings.get_int('app-preview-icon-size') || 128;
        wrapper.add_child(new St.Icon({
            gicon: item.icon,
            icon_size: largeIconSize,
            x_align: Clutter.ActorAlign.CENTER,
        }));

        wrapper.add_child(new St.Label({
            text: item.name,
            style_class: 'clone-title-overlay',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const appInfo = app.get_app_info();
        const description = appInfo?.get_description();
        if (description) {
            const descLabel = new St.Label({
                text: description,
                style_class: 'app-description-label',
                x_align: Clutter.ActorAlign.CENTER,
            });
            descLabel.clutter_text.set_line_wrap(true);
            descLabel.clutter_text.set_width(this._previewBox.width - 80);
            wrapper.add_child(descLabel);
        }

        const isFav = this._favorites.isFavorite(app.get_id());
        const pinButton = new St.Button({
            style_class: 'app-preview-pin-button',
            label: isFav ? 'Unpin from favorites (Ctrl+P)' : 'Pin to favorites (Ctrl+P)',
            can_focus: true,
        });
        pinButton.connect('clicked', () => this._togglePin(item));
        wrapper.add_child(pinButton);

        const actions = appInfo?.list_actions();
        if (actions && actions.length > 0) {
            const actionsBox = new St.BoxLayout({ vertical: true, x_align: Clutter.ActorAlign.CENTER });
            actions.forEach(action => {
                const actionButton = new St.Button({
                    style_class: 'app-preview-action-button',
                    label: appInfo.get_action_name(action),
                    can_focus: true,
                });
                actionButton.connect('clicked', () => {
                    app.launch_action(action, 0, -1);
                    this._close();
                });
                actionsBox.add_child(actionButton);
            });
            wrapper.add_child(actionsBox);
        }

        this._previewBox.add_child(wrapper);
        this._previewContent = wrapper;
    }

    _clearPreview() {
        if (!this._previewContent)
            return;
        if (this._previewContent.get_parent() === this._previewBox)
            this._previewBox.remove_child(this._previewContent);
        this._previewContent.destroy();
        this._previewContent = null;
    }

    _togglePin(item) {
        if (this._closed) return;
        const { app } = item;
        if (this._favorites.isFavorite(app.get_id()))
            this._favorites.removeFavorite(app.get_id());
        else
            this._favorites.addFavorite(app.get_id());
        // _onFavoritesChanged() (via the 'changed' signal) re-renders
        // results and refreshes this preview with the new pin state.
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (!item)
            return;
        journal(`[AppSearchOverlay] Launching: ${item.name}`);
        try {
            item.app.launch([], null);
        } catch (e) {
            journal(`[AppSearchOverlay] Failed to launch ${item.name}: ${e.message}`, true);
        }
        this._close();
    }

    _onKeyPress(event) {
        if (this._closed) return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        const mods = event.get_state();

        if (symbol === Clutter.KEY_p && (mods & Clutter.ModifierType.CONTROL_MASK)) {
            if (this._selectedIndex >= 0)
                this._togglePin(this._results[this._selectedIndex]);
            return Clutter.EVENT_STOP;
        }

        switch (symbol) {
            case Clutter.KEY_Escape:
                this._close();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                if (this._selectedIndex < this._results.length - 1)
                    this._selectIndex(this._selectedIndex + 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
                if (this._selectedIndex > 0)
                    this._selectIndex(this._selectedIndex - 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
                if (this._selectedIndex >= 0)
                    this._activateResult(this._selectedIndex);
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }
}
