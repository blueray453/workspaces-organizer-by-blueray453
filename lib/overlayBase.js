// ===== FILE: ./lib/overlayBase.js =====
// Shared base for all full-screen search overlays: modal grab, entry
// wiring, keyboard dispatch, and — critically — the focus-window
// watcher that closes an overlay when focus changes to something the
// overlay didn't cause.
//
// The focus check is state-based, not timer-based. An overlay records
// the window that had focus when it opened; a focus change to that
// window, to a window the overlay itself revealed, or to the origin
// window of a cancelled overlay is ignored. Any other change (a real
// app getting focus, a window being closed, etc.) closes the overlay.
// A transient null focus — which happens for one or two signal
// emissions while pushModal/popModal run — is ignored too.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Scheduling from './scheduling.js';
import * as Model from './model.js';
import * as Interactions from './interactions.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ==================== shared overlay base ====================
export class SearchOverlayBase {
    static _current = null;

    static get current() {
        if (SearchOverlayBase._current?._closed) SearchOverlayBase._current = null;
        return SearchOverlayBase._current;
    }

    static closeCurrent() {
        const overlay = SearchOverlayBase.current;
        if (!overlay) return false;
        overlay._close();
        return true;
    }

    constructor(settings) {
        this._settings = settings;
        this._results = [];
        this._selectedIndex = -1;
        this._query = '';
        this._initialKey = null;
        this._modalGrab = null;
        this._closed = false;
        this._closing = false;
        this._focusGuard = false;
        this._openedWithFocus = null;

        this._scope = new Scheduling.Scope();
        this._rowsScope = new Scheduling.Scope();
    }

    _trackFullscreen() { return true; }
    _computeResults(query) { return []; }
    _beforeResults(query, unchanged) { }
    _renderResults(results) { }
    _onSelectionChanged(index) { }
    _getRestoreKey(item) { return null; }
    _activateResult(index) { }
    _activateFocused() { if (this._selectedIndex >= 0) this._activateResult(this._selectedIndex); }
    _initialKeyFocus() { this._entry.grab_key_focus(); }
    _handleEscape() { this._close(); }
    _handleExtraKeys(event, symbol) { return undefined; }
    _onBeforeClose() { }
    _shouldCloseOnWindowRemoved(window) { return true; }

    _wireEntry(entry) {
        this._entry = entry;
        this._scope.connect(entry.clutter_text, 'text-changed', () => this._onSearchChanged());
        this._scope.connect(entry.clutter_text, 'key-press-event', (a, e) => this._onKeyPress(e));
    }

    _open() {
        this._openedWithFocus = Model.Display.focus_window;

        Main.layoutManager.addChrome(this._container, {
            affectsInputRegion: true, trackFullscreen: this._trackFullscreen(),
        });
        Main.layoutManager.uiGroup.set_child_above_sibling(this._container, null);
        this._modalGrab = Main.pushModal(this._container, { actionMode: Shell.ActionMode.NORMAL });
        this._initialKeyFocus();
        SearchOverlayBase._current = this;

        this._scope.connect(this._container, 'key-press-event', (a, e) => this._onKeyPress(e));

        this._scope.connect(Model.Display, 'notify::focus-window', () => {
            if (this._closed || this._closing || this._focusGuard) return;
            const f = Model.Display.focus_window;
            if (!f) return;
            if (f === this._openedWithFocus) return;
            if (this._revealed && f === this._revealed) return;
            if (this._origin?.window === f) return;
            this._close();
        });
        this._scope.connect(Model.Display, 'window-created', () => {
            if (!this._closed && !this._closing) this._close();
        });
        this._scope.connect(global.window_manager, 'destroy', (wm, actor) => {
            const window = actor.meta_window;
            if (!window || this._closed || this._closing || !this._shouldCloseOnWindowRemoved(window)) return;
            this._close();
        });
    }

    _close() {
        if (this._closed) return;
        this._closed = true;
        Interactions.getTooltip().hide();
        this._onBeforeClose();

        if (this._modalGrab) { Main.popModal(this._modalGrab); this._modalGrab = null; }
        this._rowsScope.dispose();
        this._scope.dispose();

        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();

        if (SearchOverlayBase._current === this) SearchOverlayBase._current = null;
        this._results = [];
    }

    _onSearchChanged() {
        if (this._closed) return;
        const query = this._entry.get_text().trim();
        const unchanged = query === this._query;
        this._query = query;
        this._beforeResults(query, unchanged);
        this._setResults(this._computeResults(query), unchanged);
    }

    _setResults(results, keepSelection = true) {
        const prev = this._results[this._selectedIndex];
        let previousKey = keepSelection && prev ? this._getRestoreKey(prev) : null;

        if (previousKey === null && this._initialKey !== null) previousKey = this._initialKey;
        this._initialKey = null;

        this._results = results;
        this._rowsScope.dispose();
        this._rowsScope = new Scheduling.Scope();
        this._selectedIndex = -1;
        this._renderResults(results);

        if (results.length === 0) { this._onSelectionChanged(-1); return; }
        const restored = previousKey !== null
            ? results.findIndex(item => this._getRestoreKey(item) === previousKey) : -1;
        this._selectIndex(restored >= 0 ? restored : 0);
    }

    _selectIndex(index) {
        if (this._closed || index < 0 || index >= this._results.length) return;
        if (index === this._selectedIndex) return;
        this._selectedIndex = index;
        this._onSelectionChanged(index);
    }

    _onKeyPress(event) {
        if (this._closed) return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        const handled = this._handleExtraKeys(event, symbol);
        if (handled !== undefined) return handled;

        switch (symbol) {
            case Clutter.KEY_Escape:
                this._handleEscape();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                this._selectIndex(this._selectedIndex + 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
                this._selectIndex(this._selectedIndex - 1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
                this._activateFocused();
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }
}
