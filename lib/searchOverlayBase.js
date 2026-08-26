import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { fuzzyMatch } from './fuzzyMatch.js';

// ==================== SHARED SEARCH OVERLAY BASE ====================
// Full-screen modal search-and-preview overlay skeleton shared by
// WindowSearchOverlay and AppSearchOverlay: monitor-sized container,
// search entry, results-list/preview-pane layout math, modal grab
// lifecycle, keyboard navigation, and selection/preview bookkeeping.
// Subclasses supply what's actually being searched via the hooks below
// — everything else here is identical between the two surfaces.
export class SearchOverlayBase {
    constructor(settings) {
        this._settings = settings;
        this._results = [];
        this._resultButtons = [];
        this._selectedIndex = -1;
        this._previewContent = null;
        this._modalGrab = null;
        this._closed = false;
    }

    // ---- Hooks subclasses MUST implement ----
    _getHintText() { return 'Search…'; }
    _getAllResultsSorted() { return []; }
    _getSearchLabel(item) { return item.name ?? ''; }
    _buildResultRow(item, index) { throw new Error('_buildResultRow must be implemented'); }
    // Must build into this._previewContent and add it to this._previewBox.
    _updatePreviewContent(item) { }
    _activateResult(index) { }

    // ---- Hooks subclasses MAY override ----
    // Key to remember/restore selection across re-filtering. Default:
    // always reselect index 0 (what WindowSearchOverlay wants).
    _getRestoreKey(item) { return null; }
    _onBeforeClose() { }
    // Return Clutter.EVENT_STOP/PROPAGATE to short-circuit the base
    // Escape/Up/Down/Enter switch below; leave undefined to fall through.
    _handleExtraKeys(event, symbol) { return undefined; }

    _buildContainer(monitor) {
        this._container = new St.Widget({
            style_class: 'window-collection-overlay',
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
    }

    _buildEntry(layout) {
        this._entry = new St.Entry({
            style_class: 'collection-search-entry',
            hint_text: this._getHintText(),
            can_focus: true,
            x: layout.panelX,
            y: layout.entryY,
            width: layout.panelWidth,
            height: layout.entryHeight,
        });
        this._entry.set_style(`font-size: ${this._settings.get_int('collection-search-font-size')}pt;`);

        this._entryChangedId = this._entry.clutter_text.connect('text-changed',
            () => this._onSearchChanged());
        this._entryKeyPressId = this._entry.clutter_text.connect('key-press-event',
            (actor, event) => this._onKeyPress(event));
    }

    // `previewVertical` differs between the two overlays' original preview
    // panes — AppSearchOverlay stacks icon/name/description/buttons
    // vertically, WindowSearchOverlay just centers a single clone actor.
    _buildResultsAndPreview(layout, { previewVertical = false } = {}) {
        this._resultsScroll = new St.ScrollView({
            style_class: 'collection-results-scroll',
            x: layout.panelX,
            y: layout.panelTop,
            width: layout.resultsWidth,
            height: layout.panelHeight,
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
            vertical: previewVertical,
            x: layout.panelX + layout.resultsWidth + 20,
            y: layout.panelTop,
            width: layout.previewWidth,
            height: layout.panelHeight,
        });
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
        this._clearPreview();
        this._onBeforeClose();

        if (this._modalGrab) {
            Main.popModal(this._modalGrab);
            this._modalGrab = null;
        }
        if (this._entry?.clutter_text) {
            this._entry.clutter_text.disconnect(this._entryChangedId);
            this._entry.clutter_text.disconnect(this._entryKeyPressId);
        }
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
    }

    // -------------------- Search / results --------------------
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
            const result = fuzzyMatch(query, this._getSearchLabel(item));
            if (result.matched)
                scored.push({ ...item, score: result.score });
        }
        scored.sort((a, b) => b.score - a.score);
        this._setResults(scored);
    }

    _setResults(results) {
        const previousKey = this._selectedIndex >= 0
            ? this._getRestoreKey(this._results[this._selectedIndex])
            : null;

        this._results = results;
        this._resultsBox.destroy_all_children();
        this._resultButtons = [];
        this._selectedIndex = -1;

        results.forEach((item, index) => {
            const button = this._buildResultRow(item, index);
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

        const restoredIndex = previousKey !== null
            ? results.findIndex(item => this._getRestoreKey(item) === previousKey)
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
        this._updatePreviewContent(item);
    }

    _clearPreview() {
        if (!this._previewContent)
            return;
        if (this._previewContent.get_parent() === this._previewBox)
            this._previewBox.remove_child(this._previewContent);
        this._previewContent.destroy();
        this._previewContent = null;
    }

    // -------------------- Keyboard --------------------
    _onKeyPress(event) {
        if (this._closed) return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        const handled = this._handleExtraKeys(event, symbol);
        if (handled !== undefined) return handled;

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