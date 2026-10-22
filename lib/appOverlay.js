// ===== FILE: ./lib/appOverlay.js =====
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as AppMenuModule from 'resource:///org/gnome/shell/ui/appMenu.js';

import * as Scheduling from './scheduling.js';
import * as Fuzzy from './fuzzy.js';
import * as Interactions from './interactions.js';
import * as UI from './ui.js';
import * as Motion from './motion.js';
import { S } from './sizes.js';

import { SearchOverlayBase, clamp } from './overlayBase.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

// ==================== launcher layout ====================
function computeLauncherLayout(monitor) {
    const margin = Math.max(24, Math.round(monitor.height * 0.04));
    const searchHeight = S.launcher.searchHeight;
    const searchWidth = Math.min(1100, monitor.width - margin * 2);

    const searchY = margin;
    const pinnedY = searchY + searchHeight + 16;
    const pinnedHeight = S.launcher.pinnedSectionH;

    const resultsY = pinnedY + pinnedHeight + 16;
    const resultsHeadingHeight = S.launcher.resultsHeadingH;
    const resultsHeight = Math.max(240, monitor.height - resultsY - margin);

    const fullWidth = monitor.width - margin * 2;
    const innerWidth = fullWidth - 40;
    const columns = Math.max(2, Math.min(8, Math.floor(innerWidth / 240)));
    const tileWidth = Math.floor(innerWidth / columns);

    return {
        margin, searchWidth,
        searchX: Math.round((monitor.width - searchWidth) / 2), searchY,
        fullWidth, fullX: margin,
        pinnedY, pinnedHeight,
        resultsY, resultsHeadingHeight, resultsHeight,
        columns, tileWidth,
        tileHeight: S.launcher.tileH, iconSize: S.launcher.tileIcon,
        pinnedTileWidth: S.launcher.pinnedTile, pinnedTileHeight: S.launcher.pinnedTile,
        pinnedIconSize: S.launcher.pinnedIcon,
    };
}

// ==================== app launcher ====================
export class AppSearchOverlay extends SearchOverlayBase {
    constructor(settings) {
        super(settings);
        this._favorites = AppFavorites.getAppFavorites();
        this._menuManager = null;
        this._openMenu = null;

        this._justDroppedAppId = null;
        this._apps = null;
        this._pinnedScope = new Scheduling.Scope();
        this._ghost = Interactions.createReorderGhost({ iconSize: () => S.launcher.pinnedIcon });

        this._zone = 'grid';
        this._pinnedIndex = 0;
        this._pinnedItems = [];
        this._pinnedButtons = [];
        this._buttons = [];
        this._focusedGridBtn = null;
        this._focusedPinnedBtn = null;
        this._searching = false;
        this._resetScroll = true;
        this._lastWheel = 0;
        this._scrollTarget = 0;
        this._pinnedTarget = 0;
        this._lastPinnedWheel = 0;
        this._pinnedAdj = null;
        this._pinnedLeftFade = null;
        this._pinnedRightFade = null;

        this._buildUI();
        this._onSearchChanged();
        this._refreshFocus();
        this._open();
    }

    _initialKeyFocus() { this._container.grab_key_focus(); }
    _entryFocused() { return global.stage.get_key_focus() === this._entry.clutter_text; }
    _focusSearch() { this._entry.grab_key_focus(); }

    _getRestoreKey(item) { return item.app.get_id(); }
    _pinnedVisible() { return this._pinnedSection.visible && this._pinnedButtons.length > 0; }

    _shouldCloseOnWindowRemoved() { return false; }

    _getAllApps() {
        if (this._apps) return this._apps;

        const appSystem = Shell.AppSystem.get_default();
        const apps = [];
        for (const info of Gio.AppInfo.get_all()) {
            if (!info.should_show()) continue;
            const app = appSystem.lookup_app(info.get_id());
            if (app) apps.push({ app, name: app.get_name() || '', icon: app.get_icon() });
        }
        apps.sort((a, b) => a.name.localeCompare(b.name));
        return (this._apps = apps);
    }

    _launchApp(app) {
        const name = app.get_name();
        try {
            app.launch(global.get_current_time(), -1, 0);
            journal(`[AppSearchOverlay] ✅ Launched successfully: ${name}`);
            return true;
        } catch (e) {
            journal(`[AppSearchOverlay] ❌ Launch failed for ${name}: ${e.message}`, true);
            return false;
        }
    }

    _computeResults(query) {
        const all = this._getAllApps();
        if (!query) return all.map(item => ({ ...item, indices: null }));

        const scored = [];
        for (const item of all) {
            const r = Fuzzy.fuzzyMatch(query, item.name);
            if (r.matched) scored.push({ ...item, score: r.score, indices: r.indices });
        }
        scored.sort((a, b) => b.score - a.score);

        const seen = new Set(scored.map(i => i.app.get_id()));
        for (const item of this._shellSearch(query, all)) {
            const id = item.app.get_id();
            if (seen.has(id)) continue;
            seen.add(id);
            scored.push({ ...item, score: 0, indices: null });
        }
        return scored;
    }

    _shellSearch(query, allItems) {
        const appSystem = Shell.AppSystem.get_default();
        const usage = Shell.AppUsage.get_default();

        let groups;
        try {
            groups = Shell.AppSystem.search(query);
        } catch (e) {
            journal(`[AppSearchOverlay] Shell.AppSystem.search() threw: ${e.message}`);
            return [];
        }
        if (!groups || groups.length === 0) return [];

        const itemByApp = new Map();
        for (const item of allItems) itemByApp.set(item.app, item);

        const results = [];
        for (const group of groups) {
            if (!group || group.length === 0) continue;
            const resolved = [];
            for (const id of group) {
                const app = appSystem.lookup_app(id);
                if (!app) continue;
                const item = itemByApp.get(app);
                if (item) resolved.push({ id, item });
            }
            if (resolved.length === 0) continue;
            resolved.sort((a, b) => usage.compare(a.id, b.id));
            for (const { item } of resolved) results.push(item);
        }
        return results;
    }

    _beforeResults(query, unchanged) {
        const searching = query.length > 0;
        if (searching && this._zone === 'pinned') this._zone = 'grid';
        this._searching = searching;
        this._resetScroll = !unchanged;
        this._syncSectionVisibility();
    }

    _syncSectionVisibility() {
        this._pinnedSection.visible = this._pinnedItems.length > 0;
        this._allHeadingLabel.set_text(this._searching ? 'RESULTS' : 'ALL APPS');
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        const L = this._layout = computeLauncherLayout(monitor);
        this._cols = L.columns;
        this._tileW = L.tileWidth;
        this._container = UI.createFullscreenContainer(monitor, 'launcher-overlay');

        const search = UI.createSearchField({
            width: L.searchWidth, hint: 'Search', keyHint: "Press '/' to search", x: L.searchX, y: L.searchY,
        });
        this._wireEntry(search.entry);
        this._container.add_child(search.actor);

        const pinned = UI.createPinnedRow();
        this._pinnedBarBox = pinned.box;
        this._pinnedLeftFade = pinned.leftFade;
        this._pinnedRightFade = pinned.rightFade;
        this._wirePinnedScroll(pinned);
        this._pinnedStrip = Interactions.createDropStrip({
            container: this._pinnedBarBox, ghost: this._ghost,
            acceptSource: source => source?._dragPayload?.kind === 'app',
            externalResult: Interactions.DragMotionResult.NO_DROP,
            hint: {
                show: (anchor, text) => Interactions.getTooltip().showAbove(anchor, text),
                hide: () => Interactions.getTooltip().hide(),
            },
            hintText: insertion => {
                if (!insertion.neighbor) return 'Pin here';
                const name = insertion.neighbor._appName ?? '';
                return insertion.insertBefore ? `Move before ${name}` : `Move after ${name}`;
            },
            onDrop: (source, index, actor) => this._dropPinned(source, index, actor),
        });
        this._pinnedBarBox._delegate = this._pinnedStrip.delegate();

        this._pinnedSection = new St.BoxLayout({
            style_class: 'launcher-pinned-section', vertical: true,
            x: L.fullX, y: L.pinnedY, width: L.fullWidth, height: L.pinnedHeight,
        });
        const pinnedHeading = UI.createDividerHeading('PINNED APPS');
        this._pinnedSection.add_child(pinnedHeading.actor);
        this._pinnedSection.add_child(pinned.actor);
        this._container.add_child(this._pinnedSection);

        const heading = UI.createDividerHeading('ALL APPS');
        this._allHeadingLabel = heading.label;
        heading.actor.set_position(L.fullX, L.resultsY);
        heading.actor.set_size(L.fullWidth, L.resultsHeadingHeight);
        this._container.add_child(heading.actor);

        const grid = UI.createGridScroll();
        this._gridScroll = grid.scroll;
        this._gridBox = grid.box;
        grid.scroll.set_position(L.fullX, L.resultsY + L.resultsHeadingHeight);
        grid.scroll.set_size(L.fullWidth, L.resultsHeight - L.resultsHeadingHeight);
        this._container.add_child(grid.scroll);

        this._scope.connect(this._gridScroll, 'scroll-event', (a, e) => this._onGridScroll(e));
        this._scope.connect(this._favorites, 'changed', () => this._onFavoritesChanged());
        this._scope.connect(Shell.AppSystem.get_default(), 'installed-changed', () => { this._apps = null; });

        this._renderPinnedBar();
    }

    _wirePinnedScroll(pinned) {
        this._pinnedAdj = pinned.scroll.hadjustment;
        const update = () => this._updatePinnedFades();
        this._scope.connect(this._pinnedAdj, 'changed', update);
        this._scope.connect(this._pinnedAdj, 'notify::value', update);
        this._scope.connect(pinned.scroll, 'scroll-event', (a, e) => this._onPinnedWheel(e));
    }

    _updatePinnedFades() {
        const adj = this._pinnedAdj;
        if (!adj) return;
        const eps = 1;
        this._pinnedLeftFade.visible = adj.value > eps;
        this._pinnedRightFade.visible = adj.value + adj.page_size < adj.upper - eps;
    }

    _easePinned(delta) {
        const adj = this._pinnedAdj;
        if (!adj) return;
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastPinnedWheel > 250) this._pinnedTarget = adj.value;
        this._lastPinnedWheel = now;
        const max = Math.max(0, adj.upper - adj.page_size);
        this._pinnedTarget = clamp(this._pinnedTarget + delta, 0, max);
        adj.ease(this._pinnedTarget, { duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    _onPinnedWheel(event) {
        const dir = event.get_scroll_direction();
        let d = 0;
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) d = -1;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) d = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        } else return Clutter.EVENT_PROPAGATE;
        this._easePinned(d * this._layout.pinnedTileWidth * 0.8);
        return Clutter.EVENT_STOP;
    }

    _renderPinnedBar() {
        this._pinnedScope.dispose();
        this._pinnedScope = new Scheduling.Scope();
        this._focusedPinnedBtn = null;
        this._pinnedBarBox.destroy_all_children();
        this._pinnedButtons = [];
        this._pinnedItems = [];

        const L = this._layout;

        this._pinnedBarBox.add_child(new St.Widget({ x_expand: true }));
        for (const app of this._favorites.getFavorites()) {
            const id = app.get_id();
            const name = app.get_name() || '';
            const icon = app.get_icon();
            const index = this._pinnedItems.length;
            this._pinnedItems.push({ app, name, icon });

            const button = UI.createAppTile({
                icon, name, iconSize: L.pinnedIconSize,
                width: L.pinnedTileWidth, height: L.pinnedTileHeight,
                showLabel: false,
            });
            button._appName = name;

            this._pinnedScope.connect(button, 'clicked', () => {
                this._zone = 'pinned'; this._pinnedIndex = index; this._refreshFocus();
                if (this._launchApp(app)) this._close();
            });
            this._pinnedScope.connect(button, 'button-press-event', (a, e) => {
                if (e.get_button() === Clutter.BUTTON_SECONDARY) {
                    this._openContextMenuForApp(app, button);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._pinnedScope.connect(button, 'notify::hover', () => {
                if (this._closed) return;
                if (button.hover) {
                    Interactions.getTooltip().showBelow(button, name);
                } else {
                    Interactions.getTooltip().hide();
                }
            });

            Interactions.makeDraggable(button, {
                iconSize: S.launcher.pinnedIcon,
                payload: { kind: 'app', appId: id, gicon: icon, name },
                delegate: this._pinnedStrip.delegate(),
                onDragBegin: () => { Interactions.getTooltip().hide(); },
                onDragEnd: () => { this._ghost.clear(); Interactions.getTooltip().hide(); },
            });

            this._pinnedBarBox.add_child(button);
            this._pinnedButtons.push(button);

            if (id === this._justDroppedAppId) {
                this._justDroppedAppId = null;
                Motion.settle(button);
            }
        }
        this._pinnedBarBox.add_child(new St.Widget({ x_expand: true }));

        this._pinnedIndex = clamp(this._pinnedIndex, 0, Math.max(0, this._pinnedItems.length - 1));
        this._syncSectionVisibility();
        this._scope.idle(() => { this._updatePinnedFades(); return GLib.SOURCE_REMOVE; });
    }

    _renderResults(results) {
        const L = this._layout;
        this._focusedGridBtn = null;
        this._gridBox.destroy_all_children();
        this._buttons = [];

        let row = null;
        results.forEach((item, index) => {
            if (index % this._cols === 0) {
                row = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER, width: this._cols * this._tileW });
                this._gridBox.add_child(row);
            }
            const button = UI.createAppTile({
                icon: item.icon, name: item.name, indices: item.indices,
                iconSize: L.iconSize, width: L.tileWidth, height: L.tileHeight,
            });
            this._rowsScope.connect(button, 'clicked', () => {
                this._zone = 'grid'; this._selectedIndex = index; this._refreshFocus();
                this._activateResult(index);
            });
            this._rowsScope.connect(button, 'button-press-event', (a, e) => {
                if (e.get_button() === Clutter.BUTTON_SECONDARY) {
                    this._openContextMenuForApp(item.app, button);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            row.add_child(button);
            this._buttons.push(button);
        });

        if (this._resetScroll) {
            this._gridScroll.vadjustment.value = 0;
            this._scrollTarget = 0;
        }
    }

    _onSelectionChanged() { this._refreshFocus(); }

    _refreshFocus() {
        this._focusedGridBtn?.remove_style_class_name('focused');
        this._focusedPinnedBtn?.remove_style_class_name('focused');
        this._focusedGridBtn = this._focusedPinnedBtn = null;

        if (this._zone === 'pinned') {
            this._focusedPinnedBtn = this._pinnedButtons[this._pinnedIndex] ?? null;
            this._focusedPinnedBtn?.add_style_class_name('focused');
        } else {
            this._focusedGridBtn = this._buttons[this._selectedIndex] ?? null;
            this._focusedGridBtn?.add_style_class_name('focused');
        }
    }

    _scrollToFocus() {
        if (this._zone === 'grid' && this._focusedGridBtn) {
            Util.ensureActorVisibleInScrollView(this._gridScroll, this._focusedGridBtn);
        } else if (this._zone === 'pinned' && this._focusedPinnedBtn && this._pinnedAdj) {
            const adj = this._pinnedAdj;
            const [value, , , , , page] = adj.get_values();
            const box = this._focusedPinnedBtn.get_allocation_box();
            if (box.x1 < value) adj.ease(box.x1 - 16, { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            else if (box.x2 > value + page) adj.ease(box.x2 - page + 16, { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        }
    }

    _afterFocusMove() { this._refreshFocus(); this._scrollToFocus(); }

    _centerX(button) {
        const [x] = button.get_transformed_position();
        return x + button.width / 2;
    }

    _nearestIndex(buttons, cx) {
        let best = 0, bestDist = Infinity;
        buttons.forEach((b, i) => {
            const d = Math.abs(this._centerX(b) - cx);
            if (d < bestDist) { best = i; bestDist = d; }
        });
        return best;
    }

    _moveFocus(dx, dy) {
        if (this._zone === 'pinned') {
            const n = this._pinnedButtons.length;
            if (dx) this._pinnedIndex = clamp(this._pinnedIndex + dx, 0, n - 1);
            else if (dy > 0 && this._buttons.length) {
                const cx = this._centerX(this._pinnedButtons[this._pinnedIndex]);
                this._zone = 'grid';
                this._selectedIndex = this._nearestIndex(this._buttons.slice(0, this._cols), cx);
            }
            this._afterFocusMove();
            return;
        }

        const n = this._buttons.length;
        if (!n) return;
        const cols = this._cols;
        let i = this._selectedIndex;
        if (dx) i = clamp(i + dx, 0, n - 1);
        if (dy) {
            const next = i + dy * cols;
            if (next < 0) {
                if (this._pinnedVisible()) {
                    this._pinnedIndex = this._nearestIndex(this._pinnedButtons, this._centerX(this._buttons[i]));
                    this._zone = 'pinned';
                    this._afterFocusMove();
                }
                return;
            }
            if (next >= n) { if (Math.floor(i / cols) < Math.floor((n - 1) / cols)) i = n - 1; }
            else i = next;
        }
        this._selectedIndex = i;
        this._afterFocusMove();
    }

    _onGridScroll(event) {
        const adj = this._gridScroll.vadjustment;
        const dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP) delta = -1;
        else if (dir === Clutter.ScrollDirection.DOWN) delta = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) delta = event.get_scroll_delta()[1];
        else return Clutter.EVENT_PROPAGATE;

        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastWheel > 250) this._scrollTarget = adj.value;
        this._lastWheel = now;

        const max = adj.upper - adj.page_size;
        this._scrollTarget = clamp(this._scrollTarget + delta * this._layout.tileHeight * 0.75, 0, Math.max(0, max));
        adj.ease(this._scrollTarget, { duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        return Clutter.EVENT_STOP;
    }

    _handleExtraKeys(event, symbol) {
        const state = event.get_state();
        if (symbol === Clutter.KEY_p && (state & Clutter.ModifierType.CONTROL_MASK)) {
            const item = this._zone === 'pinned' ? this._pinnedItems[this._pinnedIndex] : this._results[this._selectedIndex];
            if (item) this._togglePin(item);
            return Clutter.EVENT_STOP;
        }

        const inEntry = this._entryFocused();
        switch (symbol) {
            case Clutter.KEY_slash:
                if (inEntry) return undefined;
                this._focusSearch();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Left: this._moveFocus(-1, 0); return Clutter.EVENT_STOP;
            case Clutter.KEY_Right: this._moveFocus(1, 0); return Clutter.EVENT_STOP;
            case Clutter.KEY_Up: this._moveFocus(0, -1); return Clutter.EVENT_STOP;
            case Clutter.KEY_Down: this._moveFocus(0, 1); return Clutter.EVENT_STOP;
        }

        if (!inEntry && !(state & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK))) {
            const uc = event.get_key_unicode();
            const code = typeof uc === 'string' ? uc.codePointAt(0) : uc;
            if (code && code >= 0x20 && code !== 0x7f) {
                this._focusSearch();
                this._entry.clutter_text.insert_unichar(code);
                return Clutter.EVENT_STOP;
            }
        }
        return undefined;
    }

    _handleEscape() {
        if (this._entry.get_text().length > 0) {
            this._entry.set_text('');
            this._container.grab_key_focus();
            return;
        }
        this._close();
    }

    _activateFocused() {
        if (this._zone === 'pinned') {
            const item = this._pinnedItems[this._pinnedIndex];
            if (item && this._launchApp(item.app)) this._close();
            return;
        }
        if (this._selectedIndex >= 0) this._activateResult(this._selectedIndex);
    }

    _activateResult(index) {
        if (this._closed) return;
        const item = this._results[index];
        if (item && this._launchApp(item.app)) this._close();
    }

    _dropPinned(source, index, actor) {
        const appId = source?._dragPayload?.appId;
        if (!appId) return false;

        const pos = index ?? this._pinnedBarBox.get_children().length;
        this._justDroppedAppId = appId;

        try { this._favorites.moveFavoriteToPos(appId, pos); }
        catch (e) { journal(`[AppSearchOverlay] Reorder failed: ${e.message}`); }

        if (actor) { actor.get_parent()?.remove_child(actor); actor.destroy(); }
        return true;
    }

    _openContextMenuForApp(app, sourceActor) {
        this._closeContextMenu();
        const manager = new PopupMenu.PopupMenuManager(sourceActor);
        this._menuManager = manager;

        const menu = new AppMenuModule.AppMenu(sourceActor, St.Side.BOTTOM, { favoritesSection: true, showSingleWindows: true });
        Main.layoutManager.addChrome(menu.actor);
        menu.actor.hide();
        manager.addMenu(menu);
        menu.setApp(app);
        this._openMenu = menu;

        menu.connect('open-state-changed', (o, isOpen) => {
            if (isOpen) return;
            if (menu === this._openMenu) this._openMenu = null;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!menu.is_destroyed) menu.destroy();
                try { manager.destroy(); } catch (e) { /* already gone */ }
                return GLib.SOURCE_REMOVE;
            });
        });
        menu.open(true);
    }

    _closeContextMenu() {
        if (this._openMenu) {
            const menu = this._openMenu;
            this._openMenu = null;
            try { menu.close(); } catch (e) { }
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!menu.is_destroyed) menu.destroy();
                return GLib.SOURCE_REMOVE;
            });
        }
        if (this._menuManager) {
            try { this._menuManager.destroy(); } catch (e) { /* gone */ }
            this._menuManager = null;
        }
    }

    _togglePin(item) {
        if (this._closed) return;
        const id = item.app.get_id();
        if (this._favorites.isFavorite(id)) this._favorites.removeFavorite(id);
        else this._favorites.addFavorite(id);
    }

    _onFavoritesChanged() {
        if (this._closed) return;
        this._renderPinnedBar();
        this._onSearchChanged();
        this._refreshFocus();
    }

    _onBeforeClose() {
        this._closeContextMenu();
        this._ghost.clear();
        this._pinnedScope.dispose();
        Interactions.getTooltip().hide();
        this._apps = null;
    }

    _close() {
        if (this._closed) return;
        super._close();
    }
}