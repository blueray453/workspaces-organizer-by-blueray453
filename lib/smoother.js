// ===== FILE: ./lib/smoother.js =====
import GLib from 'gi://GLib';
import { reduced } from './motion.js';

export class Smoother {
    constructor(scope, { tau = 70, epsilon = 0.002, frameMs = 16, onFrame, onSettle = null }) {
        this._scope = scope;
        this.tau = tau; this.epsilon = epsilon; this.frameMs = frameMs;
        this._onFrame = onFrame; this._onSettle = onSettle;
        this.value = 0; this.target = 0;
        this._id = 0; this._last = 0;
    }
    get running() { return this._id !== 0; }

    snap(v) { this.stop(); this.value = this.target = v; this._onFrame(v); }

    to(target) {
        this.target = target;
        if (reduced()) return this.snap(target);
        if (this._id) return;
        this._last = GLib.get_monotonic_time() / 1000;
        this._id = this._scope.timeout(this.frameMs, () => this._step());
    }

    _step() {
        const now = GLib.get_monotonic_time() / 1000;
        const dt = Math.min(now - this._last, 50);
        this._last = now;
        const diff = this.target - this.value;
        if (Math.abs(diff) < this.epsilon) {
            this.value = this.target;
            this._id = 0;
            this._onFrame(this.value);
            this._onSettle?.();
            return GLib.SOURCE_REMOVE;
        }
        this.value += diff * (1 - Math.exp(-dt / this.tau));
        this._onFrame(this.value);
        return GLib.SOURCE_CONTINUE;
    }

    stop() { if (this._id) { this._scope.cancel(this._id); this._id = 0; } }
}