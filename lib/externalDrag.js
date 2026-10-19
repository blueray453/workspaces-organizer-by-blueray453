// ===== FILE: ./lib/externalDrag.js =====
// Drags that originate OUTSIDE the shell (Nautilus, Nemo, Firefox, …) never
// enter the internal St DND chain, so no `handleDragOver`/`acceptDrop` ever
// fires on our actors. The only reliable early signal is Meta.Selection's
// SELECTION_DND owner: an external client claims it when the drag starts and
// replaces it with a Memory source when the drag ends.
//
// This is the same approach as the ExternalDragNotify diagnostic extension:
// BEGIN/CLEAR come exclusively from the Selection watch. Meta.Dnd's
// dnd-enter / dnd-leave are late and fire per-stage-entry, not per-drag, so
// they are hooked as DIAGNOSTICS ONLY — a STAGE-ENTER without a preceding
// BEGIN means the early signal missed that drag.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const DRAG_MAX_MS = 30000;

const TEXT_TYPES = [
    'text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT',
];

function typeName(obj) {
    if (!obj) return 'null';
    return obj.constructor?.$gtype?.name ?? obj.constructor?.name ?? 'unknown';
}

function isMemory(source) {
    return source instanceof Meta.SelectionSourceMemory || typeName(source).includes('Memory');
}

function mimesOf(source) {
    try { return source?.get_mimetypes() ?? []; } catch (e) { return []; }
}

function classify(mimes) {
    if (mimes.includes('text/uri-list')) return 'files';
    if (TEXT_TYPES.some(t => mimes.includes(t))) return 'text';
    if (mimes.length === 0) return 'unknown';
    return 'other';
}

class ExternalDragWatcher {
    constructor() {
        this._current = null;
        this._selection = null;
        this._selectionId = 0;
        this._dnd = null;
        this._dndIds = [];
        this._listeners = new Set();
        this._expiryId = 0;
        this._counter = 0;
        this._started = false;
    }

    /** { id, kind, mimes, app, startedAt } or null. */
    get current() { return this._current; }

    get active() { return this._current !== null; }

    /** cb(state|null) — fired on begin and on end, never in between. */
    onChanged(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    init() {
        if (this._started) return;
        this._started = true;

        // ---- early signal (state transitions) ----
        this._selection = global.display.get_selection();
        if (!this._selection) {
            journal('[externalDrag] no Meta.Selection — external drags unsupported');
            return;
        }
        this._selectionId = this._selection.connect('owner-changed',
            (sel, type, source) => this._onOwnerChanged(type, source));

        // ---- late signals (diagnostics only, as in ExternalDragNotify) ----
        try {
            this._dnd = global.backend.get_dnd();
            this._dndIds.push(this._dnd.connect('dnd-enter', () => this._onStageEnter()));
            this._dndIds.push(this._dnd.connect('dnd-leave', () => {
                journal(`[externalDrag] STAGE-LEAVE${this._current ? ` #${this._current.id}` : ''}`);
            }));
        } catch (e) {
            journal(`[externalDrag] backend dnd hooks unavailable: ${e.message}`);
        }
    }

    _onStageEnter() {
        if (this._current) {
            const t = Math.round(GLib.get_monotonic_time() / 1000 - this._current.startedAt);
            journal(`[externalDrag] STAGE-ENTER #${this._current.id} t=${t}ms`);
        } else {
            const app = global.display.focus_window?.get_wm_class() ?? 'unknown';
            journal(`[externalDrag] STAGE-ENTER LATE-ONLY (no early begin) focus=${app}`);
        }
    }

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_DND) return;

        if (!source || isMemory(source)) { this.end('owner-cleared'); return; }

        const mimes = mimesOf(source);
        if (mimes.length === 0) { this.end('no-mimes'); return; }

        const previous = this._current;
        this._current = {
            // A new begin without an end keeps the same id; otherwise allocate one.
            id: previous ? previous.id : ++this._counter,
            kind: classify(mimes),
            mimes,
            app: global.display.focus_window?.get_wm_class() ?? 'unknown',
            startedAt: GLib.get_monotonic_time() / 1000,
        };

        journal(`[externalDrag] begin #${this._current.id} kind=${this._current.kind} ` +
            `app=${this._current.app} src=${typeName(source)} n=${mimes.length}`);
        if (this._current.kind === 'other')
            journal(`[externalDrag]   mimes=${mimes.join(',')}`);

        if (this._expiryId) GLib.Source.remove(this._expiryId);
        this._expiryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAG_MAX_MS, () => {
            this._expiryId = 0;
            this.end('expired');
            return GLib.SOURCE_REMOVE;
        });

        this._emit();
    }

    /** Public so the UI's pointer poll can add backstops. */
    end(reason) {
        const drag = this._current;
        if (!drag) return;
        this._current = null;
        if (this._expiryId) { GLib.Source.remove(this._expiryId); this._expiryId = 0; }
        journal(`[externalDrag] end #${drag.id} via=${reason} ` +
            `after=${Math.round(GLib.get_monotonic_time() / 1000 - drag.startedAt)}ms`);
        this._emit();
    }

    _emit() {
        for (const cb of [...this._listeners]) {
            try { cb(this._current); }
            catch (e) { journal(`[externalDrag] listener failed: ${e.message}`); }
        }
    }

    destroy() {
        this.end('destroyed');
        this._listeners.clear();
        if (this._selection && this._selectionId) {
            try { this._selection.disconnect(this._selectionId); } catch (e) { /* gone */ }
        }
        this._selection = null;
        this._selectionId = 0;
        if (this._dnd) {
            for (const id of this._dndIds) {
                try { this._dnd.disconnect(id); } catch (e) { /* gone */ }
            }
        }
        this._dnd = null;
        this._dndIds = [];
        this._started = false;
    }
}

export const externalDrag = new ExternalDragWatcher();

export function initExternalDrag() { externalDrag.init(); }
export function destroyExternalDrag() { externalDrag.destroy(); }

/** True when dragging the primary button is plausible. Used as a backstop. */
export function buttonHeld(mods) {
    return (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
}