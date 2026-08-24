import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';
import { fuzzyMatch } from './fuzzyMatch.js';
import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

const PINNED_ICON_SIZE = 96;
const PINNED_BAR_HEIGHT = 120;

export class AppSearchOverlay {
    constructor(settings) {
        this._settings = settings;
        this._favorites = AppFavorites.getAppFavorites();
        this._results = [];
        this._resultButtons = [];
        this._selectedIndex = -1;
        this._modalGrab = null;
        this._closed = false;
        this._menuManager = null;
        this._openMenu = null;

        this._buildUI();
        this._setResults(this._getAllResultsSorted());
        this._open();
    }

    // -------------------- Safe app enumeration --------------------
    _getAllApps() {
        const appSystem = Shell.AppSystem.get_default();
        let appInfos = [];

        if (appSystem && typeof appSystem.get_all === 'function') {
            try {
                appInfos = appSystem.get_all().filter(app => {
                    try { return app.should_show(); } catch { return false; }
                });
            } catch (e) {
                journal(`[AppSearchOverlay] Shell.AppSystem.get_all() failed: ${e.message}`);
            }
        }

        if (appInfos.length === 0) {
            try {
                const gioApps = Gio.AppInfo.get_all().filter(app => {
                    try { return app.should_show(); } catch { return false; }
                });
                for (const info of gioApps) {
                    let shellApp = null;
                    if (appSystem && typeof appSystem.lookup_app === 'function') {
                        try {
                            shellApp = appSystem.lookup_app(info.get_id());
                        } catch (e) { }
                    }
                    appInfos.push(shellApp || info);
                }
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
                    let id, name, icon;
                    if (typeof app.get_id === 'function') {
                        id = app.get_id();
                    } else {
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
                        app,
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

    // -------------------- CORRECT LAUNCH METHOD (3 arguments) --------------------
    _launchApp(app) {
        const name = typeof app.get_name === 'function' ? app.get_name() : 'unknown';
        journal(`[AppSearchOverlay] Launching: ${name}`);
        try {
            // Shell.App.launch requires 3 arguments: timestamp, workspace, gpu_pref
            const timestamp = global.get_current_time();
            app.launch(timestamp, -1, 0);  // -1 = default workspace, 0 = default GPU
            journal(`[AppSearchOverlay] ✅ Launched successfully: ${name}`);
            return true;
        } catch (e) {
            journal(`[AppSearchOverlay] ❌ Launch failed for ${name}: ${e.message}`, true);
            journal(`     Stack: ${e.stack}`);
            return false;
        }
    }

    // -------------------- UI Construction --------------------
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

        // ---- Pinned bar ----
        this._pinnedBarBox = new St.BoxLayout({
            style_class: 'dmenu-pinned-bar',
            vertical: false,
            x_expand: true,
            y_expand: false,
            height: PINNED_BAR_HEIGHT,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        this._pinnedBarBox.hide();

        // ---- Entry ----
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

        // ---- Results & Preview ----
        const resultsWidth = Math.round(panelWidth * 0.32);
        const previewWidth = panelWidth - resultsWidth - 20;
        const panelHeight = monitor.height - (panelTop - monitor.y) - margin;

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

        // ---- Assemble ----
        const mainVertical = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        const pinnedWrapper = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_expand: false,
            style: 'padding: 0 0 8px 0;',
        });
        pinnedWrapper.add_child(this._pinnedBarBox);

        const entryWrapper = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_expand: false,
        });
        entryWrapper.add_child(this._entry);

        const resultsPreviewRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_expand: true,
        });
        resultsPreviewRow.add_child(this._resultsScroll);
        resultsPreviewRow.add_child(this._previewBox);

        mainVertical.add_child(pinnedWrapper);
        mainVertical.add_child(entryWrapper);
        mainVertical.add_child(resultsPreviewRow);

        mainVertical.set_position(panelX, entryY);
        mainVertical.set_size(panelWidth, monitor.height - margin * 2);
        this._container.add_child(mainVertical);

        // ---- Signals ----
        this._entryChangedId = this._entry.clutter_text.connect('text-changed',
            () => this._onSearchChanged());
        this._entryKeyPressId = this._entry.clutter_text.connect('key-press-event',
            (actor, event) => this._onKeyPress(event));

        this._favoritesChangedId = this._favorites.connect('changed', () => {
            this._onFavoritesChanged();
        });

        this._renderPinnedBar();
        journal(`[AppSearchOverlay] Build UI End`);
    }

    // -------------------- Pinned Bar --------------------
    _renderPinnedBar() {
        this._pinnedBarBox.remove_all_children();
        const favorites = this._favorites.getFavorites();

        if (!favorites || favorites.length === 0) {
            this._pinnedBarBox.hide();
            return;
        }

        this._pinnedBarBox.show();

        for (const app of favorites) {
            const icon = app.get_icon();
            if (!icon) continue;

            const button = new St.Button({
                style_class: 'dmenu-pinned-icon',
                child: new St.Icon({
                    gicon: icon,
                    icon_size: PINNED_ICON_SIZE,
                }),
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            button.connect('clicked', () => {
                this._launchApp(app);
                this._close();
            });

            button.connect('button-press-event', (actor, event) => {
                if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                    this._openContextMenuForApp(app, button);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._pinnedBarBox.add_child(button);
        }
    }

    // -------------------- Context Menu --------------------
    _openContextMenuForApp(app, sourceActor) {
        this._closeContextMenu();

        if (!this._menuManager) {
            this._menuManager = new PopupMenu.PopupMenuManager(sourceActor);
        }

        const menu = new AppMenu(sourceActor, St.Side.BOTTOM, {
            favoritesSection: true,
            showSingleWindows: true,
        });
        menu.actor.add_style_class_name('dmenu-context-menu');

        Main.layoutManager.addChrome(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);
        menu.setApp(app);

        this._openMenu = menu;

        menu.connect('open-state-changed', (o, isOpen) => {
            if (!isOpen) {
                if (menu === this._openMenu) {
                    this._openMenu = null;
                }
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (!menu.is_destroyed) {
                        menu.destroy();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        menu.open(true);
    }

    _closeContextMenu() {
        if (this._openMenu) {
            try {
                this._openMenu.close();
            } catch (e) { }
            this._openMenu = null;
        }
    }

    // -------------------- Lifecycle --------------------
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
        this._closeContextMenu();

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

    // -------------------- Search --------------------
    _onFavoritesChanged() {
        if (this._closed) return;
        this._renderPinnedBar();
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

        const appInfo = app.get_app_info?.();
        const description = appInfo?.get_description?.();
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

        const actions = appInfo?.list_actions?.();
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
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (!item) return;
        this._launchApp(item.app);
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