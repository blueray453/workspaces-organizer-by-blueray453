// ===== FILE: ./lib/util.js =====
import GLib from 'gi://GLib';
import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

export class Emitter {
    constructor() { this._cbs = new Set(); }
    on(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
    emit(...a) {
        for (const cb of [...this._cbs]) {
            try { cb(...a); } catch (e) { journal(`listener failed: ${e.message}`, true); }
        }
    }
    clear() { this._cbs.clear(); }
}

export class Store {
    constructor(initial) {
        this._initial = { ...initial };
        this.state = { ...initial };
        this.changed = new Emitter();
    }
    patch(p) {
        let dirty = false;
        for (const k of Object.keys(p))
            if (this.state[k] !== p[k]) { this.state[k] = p[k]; dirty = true; }
        if (dirty) this.changed.emit(this.state);
        return dirty;
    }
    reset() { Object.assign(this.state, this._initial); }
}

export class Hold {
    constructor() { this._n = 0; }
    get active() { return this._n > 0; }
    acquire() {
        this._n++;
        let done = false;
        return () => { if (done) return; done = true; if (this._n > 0) this._n--; };
    }
}

export class Dwell {
    constructor(scope, ms, { rearmAfterFire = false } = {}) {
        this._scope = scope;
        this._ms = typeof ms === 'function' ? ms : () => ms;
        this._rearm = rearmAfterFire;
        this._id = 0; this._key = null;
    }
    get key() { return this._key; }
    arm(key, fn) {
        if (key === this._key) return false;
        this.cancel();
        this._key = key;
        this._id = this._scope.timeout(this._ms(), () => {
            this._id = 0;
            if (this._rearm) this._key = null;
            fn();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }
    cancel() {
        if (this._id) { this._scope.cancel(this._id); this._id = 0; }
        this._key = null;
    }
}

export class Poller {
    constructor(scope, { interval, tick, name = 'poll' }) {
        this._scope = scope; this._interval = interval; this._tick = tick;
        this._name = name; this._id = 0;
    }
    get running() { return this._id !== 0; }
    start() {
        if (this._id) return;
        this._id = this._scope.timeout(this._interval, () => {
            let r;
            try { r = this._tick(); }
            catch (e) { journal(`${this._name} tick threw: ${e.message}\n${e.stack}`, true); }
            if (r === false) { this._id = 0; return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        });
    }
    stop() { if (this._id) { this._scope.cancel(this._id); this._id = 0; } }
}

export class Misses {
    constructor(limit, onLimit) { this.limit = limit; this.onLimit = onLimit; this.n = 0; }
    reset() { this.n = 0; }
    miss() { if (++this.n >= this.limit) { this.n = 0; this.onLimit(); return true; } return false; }
}