// ===== FILE: ./lib/motion.js =====
import Clutter from 'gi://Clutter';

const Mode = Clutter.AnimationMode;

const _cfg = {
    reduce: false,
    speed: 1,
    durations: {
        fadeIn: 200, fadeOut: 130, settle: 300, pop: 220,
        slideIn: 190, slideOut: 130, glide: 150,
        tooltipFade: 120, dashOpen: 180, dashClose: 140,
        selectBorder: 150, selectPopOut: 150, overlayFade: 220, cancelFlash: 180,
    },
};

export function configureMotion({ reduceMotion, speed, durations } = {}) {
    if (reduceMotion !== undefined) _cfg.reduce = !!reduceMotion;
    if (speed !== undefined) _cfg.speed = speed;
    if (durations) Object.assign(_cfg.durations, durations);
}
export const reduced = () => _cfg.reduce;

export function dur(nameOrMs) {
    if (_cfg.reduce) return 0;
    const ms = typeof nameOrMs === 'number' ? nameOrMs : _cfg.durations[nameOrMs];
    if (ms === undefined) {
        console.error(`[motion] unknown duration: ${nameOrMs}`);
        return 0;
    }
    return Math.round(ms * _cfg.speed);
}

export function animate(actor, props, { duration = 'fadeIn', mode = Mode.EASE_OUT_QUAD, onComplete } = {}) {
    if (!actor) return;
    try { if (!actor.get_stage()) return; } catch (e) { return; }
    actor.remove_all_transitions();
    const ms = dur(duration);
    if (ms === 0) {
        for (const [k, v] of Object.entries(props)) actor[k] = v;
        onComplete?.();
        return;
    }
    actor.ease({ ...props, duration: ms, mode, onComplete });
}

export function fadeIn(actor, o = {}) {
    if (!actor) return;
    try { if (!actor.get_stage()) return; } catch (e) { return; }
    actor.opacity = 0;
    animate(actor, { opacity: 255 }, { duration: 'fadeIn', ...o });
}
export function fadeOut(actor, o = {}) {
    animate(actor, { opacity: 0 }, { duration: 'fadeOut', mode: Mode.EASE_IN_QUAD, ...o });
}
export function settle(actor, o = {}) {
    if (!actor) return;
    try { if (!actor.get_stage()) return; } catch (e) { return; }
    actor.remove_all_transitions();
    actor.set_pivot_point(0.5, 0.5);
    actor.set_scale(0.85, 0.85);
    actor.opacity = 160;
    animate(actor, { scale_x: 1, scale_y: 1, opacity: 255 }, { duration: 'settle', ...o });
}
export function pop(actor, { from = 0.96, ...o } = {}) {
    if (!actor) return;
    actor.set_pivot_point(0.5, 0.5);
    actor.set_scale(from, from);
    animate(actor, { scale_x: 1, scale_y: 1 }, { duration: 'pop', mode: Mode.EASE_OUT_BACK, ...o });
}
export function enter(actor, { dx = 0, dy = 0, scale = 0.96, ...o } = {}) {
    actor.remove_all_transitions();
    actor.show();
    actor.opacity = 255;
    actor.translation_x = dx; actor.translation_y = dy;
    actor.set_scale(scale, scale);
    animate(actor, { translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1 },
        { duration: 'slideIn', mode: Mode.EASE_OUT_CUBIC, ...o });
}
export function exit(actor, { dx = 0, dy = 0, scale = 0.97, ...o } = {}) {
    animate(actor, { opacity: 0, translation_x: dx, translation_y: dy, scale_x: scale, scale_y: scale },
        { duration: 'slideOut', mode: Mode.EASE_IN_QUAD, ...o });
}
export function glide(actor, x, y, o = {}) {
    if (Math.abs(actor.x - x) < 1 && Math.abs(actor.y - y) < 1) return;
    animate(actor, { x, y }, { duration: 'glide', ...o });
}