// ===== FILE: ./lib/windowBorder.js =====
import St from 'gi://St';
import * as Motion from './motion.js';

const SIGNALS = ['position-changed', 'size-changed',
    'notify::maximized-horizontally', 'notify::maximized-vertically'];

export class WindowBorder {
    constructor(styleClass, { fade = null } = {}) {
        this._styleClass = styleClass;
        this._fade = fade;
        this._bin = null;
        this._win = null;
        this._actor = null;
        this._ids = [];
    }
    get window() { return this._win; }
    get actor() { return this._actor; }

    show(win) {
        const actor = win?.get_compositor_private();
        const parent = actor?.get_parent();
        if (!parent) { this.hide(); return false; }

        if (this._win !== win || this._actor !== actor || this._bin?.get_parent() !== parent) {
            this.hide();
            this._bin ??= new St.Bin({ style_class: this._styleClass, reactive: false });
            this._win = win;
            this._actor = actor;
            parent.add_child(this._bin);
            this._ids = SIGNALS.map(s => win.connect(s, () => this.reposition()));
            if (this._fade) {
                this._bin.opacity = 0;
                Motion.animate(this._bin, { opacity: 255 }, { duration: this._fade });
            }
        }
        this.reposition();
        return true;
    }

    reposition() {
        if (!this._bin || !this._win || !this._bin.get_parent()) return;
        const r = this._win.get_frame_rect();
        this._bin.set_position(r.x, r.y);
        this._bin.set_size(r.width, r.height);
        this.restack();
    }

    restack() {
        if (!this._bin?.get_parent() || !this._actor) return;
        global.get_window_group().set_child_above_sibling(this._bin, this._actor);
    }

    hide() {
        for (const id of this._ids) { try { this._win?.disconnect(id); } catch (e) { /* gone */ } }
        this._ids = [];
        if (this._bin) {
            this._bin.remove_all_transitions();
            this._bin.get_parent()?.remove_child(this._bin);
        }
        this._win = null;
        this._actor = null;
    }

    destroy() {
        this.hide();
        this._bin?.destroy();
        this._bin = null;
    }
}