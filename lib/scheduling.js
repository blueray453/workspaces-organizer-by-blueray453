import GLib from 'gi://GLib';

/**
 * Owns the signals and GLib sources created by one imperative object.
 */
export class Scope {
    constructor() {
        this._signals = [];
        this._sources = [];
        this._disposed = false;
    }

    get disposed() { return this._disposed; }

    connect(obj, signal, cb) {
        if (this._disposed) return 0;
        const id = obj.connect(signal, cb);
        this._signals.push([obj, id]);
        return id;
    }

    timeout(ms, cb, priority = GLib.PRIORITY_DEFAULT) {
        if (this._disposed) return 0;
        let id = 0;
        id = GLib.timeout_add(priority, ms, () => {
            const r = cb();
            if (r !== GLib.SOURCE_CONTINUE) this._forgetSource(id);
            return r ?? GLib.SOURCE_REMOVE;
        });
        this._sources.push(id);
        return id;
    }

    idle(cb, priority = GLib.PRIORITY_DEFAULT) {
        if (this._disposed) return 0;
        let id = 0;
        id = GLib.idle_add(priority, () => {
            const r = cb();
            if (r !== GLib.SOURCE_CONTINUE) this._forgetSource(id);
            return r ?? GLib.SOURCE_REMOVE;
        });
        this._sources.push(id);
        return id;
    }

    cancel(id) {
        if (!id) return;
        this._forgetSource(id);
        try { GLib.Source.remove(id); } catch (e) { /* already gone */ }
    }

    disconnectSignals() {
        for (const [obj, id] of this._signals) {
            try { obj.disconnect(id); } catch (e) { /* obj may be gone */ }
        }
        this._signals = [];
    }

    _forgetSource(id) {
        const i = this._sources.indexOf(id);
        if (i !== -1) this._sources.splice(i, 1);
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        for (const [obj, id] of this._signals) {
            try { obj.disconnect(id); } catch (e) { /* obj may be gone */ }
        }
        for (const id of this._sources) {
            try { GLib.Source.remove(id); } catch (e) { /* already gone */ }
        }
        this._signals = [];
        this._sources = [];
    }
}

export class Coalescer {
    constructor(fn) {
        this._fn = fn;
        this._id = 0;
        this._delay = 0;
    }

    queue(delay = 0) {
        if (this._id) {
            if (delay >= this._delay) return;
            GLib.Source.remove(this._id);
        }
        this._delay = delay;
        const run = () => { this._id = 0; this._fn(); return GLib.SOURCE_REMOVE; };
        this._id = delay
            ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, run)
            : GLib.idle_add(GLib.PRIORITY_DEFAULT, run);
    }

    cancel() {
        if (this._id) { GLib.Source.remove(this._id); this._id = 0; }
    }
}