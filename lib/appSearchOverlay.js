import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import Shell from 'gi://Shell';

import { SearchOverlayBase } from './searchOverlayBase.js';
import { InsertionPlaceholder, describeInsertion } from './insertionPlaceholder.js';
import { FloatingTooltip } from './floatingTooltip.js';
import { settleIcon } from './animationHelpers.js';
import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

const PINNED_ICON_SIZE = 96;
const PINNED_BAR_HEIGHT = 120;

export class AppSearchOverlay extends SearchOverlayBase {
    constructor(settings) {
        super(settings);
        this._favorites = AppFavorites.getAppFavorites();
        this._menuManager = null;
        this._openMenu = null;

        // ---- Pinned-bar drag state ----
        this._pinnedInsertion = new InsertionPlaceholder();
        this._pinnedDragHint = null;
        this._pinnedDragActive = false;
        this._justDroppedAppId = null;

        this._buildUI();
        this._setResults(this._getAllResultsSorted());
        this._open();
    }

    // -------------------- Base hooks --------------------
    _getHintText() { return 'Search apps… (Ctrl+P: pin/unpin)'; }
    _getSearchLabel(item) { return item.name ?? ''; }
    _getRestoreKey(item) { return item.app.get_id(); }

    _handleExtraKeys(event, symbol) {
        const mods = event.get_state();
        if (symbol === Clutter.KEY_p && (mods & Clutter.ModifierType.CONTROL_MASK)) {
            if (this._selectedIndex >= 0)
                this._togglePin(this._results[this._selectedIndex]);
            return Clutter.EVENT_STOP;
        }
        return undefined;
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
            const timestamp = global.get_current_time();
            app.launch(timestamp, -1, 0);
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
        const margin = 40;
        const entryHeight = 80;
        const entryGap = 20;
        const panelWidth = monitor.width - margin * 2;
        const panelX = monitor.x + margin;
        const entryY = monitor.y + margin;
        const panelTop = entryY + entryHeight + entryGap;
        const panelHeight = monitor.height - (panelTop - monitor.y) - margin;
        const resultsWidth = Math.round(panelWidth * 0.32);
        const previewWidth = panelWidth - resultsWidth - 20;
        const layout = { monitor, margin, entryHeight, entryGap, panelWidth, panelX, entryY, panelTop, panelHeight, resultsWidth, previewWidth };

        this._buildContainer(layout.monitor);
        this._buildEntry(layout);
        this._buildResultsAndPreview(layout, { previewVertical: true });

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

        this._pinnedBarBox._delegate = this._pinnedBarBox;
        this._pinnedBarBox.handleDragOver = (source) => this._handlePinnedDragOver(source);
        this._pinnedBarBox.acceptDrop = (source, actor) => this._acceptPinnedDrop(source, actor);
        this._pinnedBarBox.hide();

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

        this._favoritesChangedId = this._favorites.connect('changed', () => {
            this._onFavoritesChanged();
        });

        this._renderPinnedBar();
        journal(`[AppSearchOverlay] Build UI End`);
    }

    // -------------------- Pinned Bar --------------------
    _renderPinnedBar() {
        this._pinnedBarBox.destroy_all_children();
        const favorites = this._favorites.getFavorites();

        if (!favorites || favorites.length === 0) {
            this._pinnedBarBox.hide();
            return;
        }

        this._pinnedBarBox.show();

        for (const app of favorites) {
            const icon = app.get_icon();
            if (!icon) continue;

            const id = app.get_id();
            const name = app.get_name?.() || '';

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
            button._appId = id;
            button._appName = name;
            button.icon_size = PINNED_ICON_SIZE;

            const tooltip = new FloatingTooltip({
                parent: this._container,
                fontSize: this._settings.get_int('tooltip-font-size'),
            });
            button._tooltip = tooltip;

            button.connect('notify::hover', () => {
                if (this._pinnedDragActive) {
                    tooltip.hide();
                    return;
                }
                if (button.hover) {
                    tooltip.showAbove(button, name);
                } else {
                    tooltip.hide();
                }
            });

            button.connect('destroy', () => {
                tooltip.destroy();
            });

            button.connect('clicked', () => {
                // if (this._pinnedDragActive) return;
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

            const draggable = DND.makeDraggable(button, {
                restoreOnSuccess: false,
                dragActorMaxSize: PINNED_ICON_SIZE,
                dragActorOpacity: 178, // ≈ 0.70 alpha, matches .reorder-drag-source
            });
            draggable.connect('drag-begin', () => {
                this._pinnedDragActive = true;
                button.add_style_class_name('reorder-drag-source');
                this._hideAllPinnedTooltips();
            });
            draggable.connect('drag-end', () => {
                this._pinnedDragActive = false;
                try { button.remove_style_class_name('reorder-drag-source'); }
                catch (e) { /* button may already be destroyed after a successful drop */ }
                this._pinnedInsertion.clear();
                this._pinnedDragHint?.hide();
            });
            button._draggable = draggable;

            button._delegate = button;
            button.handleDragOver = (source) => {
                if (!source._appId)
                    return DND.DragMotionResult.NO_DROP;
                return this._handlePinnedDragOver(source);
            };
            button.acceptDrop = (source, actor) => {
                if (!source._appId)
                    return false;
                return this._acceptPinnedDrop(source, actor);
            };

            this._pinnedBarBox.add_child(button);

            // Pop the icon in at its new spot after a successful drop —
            // same EASE_OUT_QUAD settle used for window icons.
            if (id === this._justDroppedAppId) {
                this._justDroppedAppId = null;
                settleIcon(button);
            }
        }
    }

    _hideAllPinnedTooltips() {
        for (const b of this._pinnedBarBox.get_children())
            b._tooltip?.hide();
    }

    _handlePinnedDragOver(source) {
        if (!source._appId)
            return DND.DragMotionResult.NO_DROP;

        const buttons = this._pinnedBarBox.get_children().filter(b => b._appId);
        const [pointerX] = global.get_pointer();

        const insertion = this._pinnedInsertion.computeInsertion(
            this._pinnedBarBox, buttons, source, b => b, pointerX);

        this._pinnedInsertion.show(this._pinnedBarBox, insertion.index, source, PINNED_ICON_SIZE);

        if (!this._pinnedDragHint)
            this._pinnedDragHint = new FloatingTooltip({
                parent: this._container,
                fontSize: this._settings.get_int('tooltip-font-size'),
            });

        const text = describeInsertion(insertion, b => b._appName ?? '');
        if (insertion.neighbor)
            this._pinnedDragHint.showAbove(insertion.neighbor, text);
        else
            this._pinnedDragHint.showAbove(this._pinnedBarBox, text);

        return DND.DragMotionResult.MOVE_DROP;
    }

    _acceptPinnedDrop(source, actor) {
        if (!source._appId)
            return false;

        // Reset drag state now, before any cleanup.
        this._pinnedDragActive = false;

        const index = this._pinnedInsertion.getLastIndex();
        this._pinnedInsertion.clear();
        this._pinnedDragHint?.hide();
        this._justDroppedAppId = source._appId;
        this._reorderFavoriteToIndex(source._appId, index ?? this._pinnedBarBox.get_children().length);

        if (actor) {
            if (actor.get_parent())
                actor.get_parent().remove_child(actor);
            actor.destroy();
        }

        return true;
    }

    _reorderFavoriteToIndex(sourceId, index) {
        try {
            this._favorites.moveFavoriteToPos(sourceId, index);
        } catch (e) {
            journal(`[AppSearchOverlay] Reorder failed: ${e.message}`);
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
    _onBeforeClose() {
        this._closeContextMenu();
        this._pinnedInsertion?.clear();
        this._pinnedDragHint?.destroy();
        this._pinnedDragHint = null;
        if (this._favoritesChangedId) {
            this._favorites.disconnect(this._favoritesChangedId);
            this._favoritesChangedId = null;
        }
    }

    _close() {
        if (this._closed) return;
        journal(`[AppSearchOverlay] Closing`);
        super._close();
    }

    // -------------------- Search --------------------
    _onFavoritesChanged() {
        if (this._closed) return;
        this._renderPinnedBar();
        this._onSearchChanged();
    }

    // -------------------- Results --------------------
    _buildResultRow(item, index) {
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
        return button;
    }

    _updatePreviewContent(item) {
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
}