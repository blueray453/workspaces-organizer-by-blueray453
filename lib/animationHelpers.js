import Clutter from 'gi://Clutter';
import { TimeoutDelay, SettleAnimationDuration } from './shellGlobals.js';
import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

/**
 * Fade in an actor from opacity 0 to 255.
 * @param {Clutter.Actor} actor
 * @param {number} duration - ms, defaults to TimeoutDelay (200ms)
 * @param {number} mode - Clutter.AnimationMode, defaults to EASE_OUT_QUAD
 */
export function fadeInActor(actor, duration = TimeoutDelay, mode = Clutter.AnimationMode.EASE_OUT_QUAD) {
    if (!actor) {
        journal('[fadeInActor] called with null actor');
        return;
    }
    actor.remove_all_transitions();
    actor.opacity = 0;
    journal(`[fadeInActor] fading in ${actor} (0→255) duration ${duration}ms`);
    actor.ease({
        opacity: 255,
        duration: duration,
        mode: mode,
    });
}

/**
 * "Settle" an icon: scale from 0.85 → 1.0, opacity 160 → 255.
 * Used for drop animations in pinned bar and window reorder.
 */
export function settleIcon(actor, duration = SettleAnimationDuration, mode = Clutter.AnimationMode.EASE_OUT_QUAD) {
    if (!actor) {
        journal('[settleIcon] called with null actor');
        return;
    }
    try {
        actor.remove_style_class_name('reorder-drag-source');
    } catch (e) {
        // actor may be destroyed
    }
    actor.remove_all_transitions();
    actor.set_pivot_point(0.5, 0.5);
    actor.set_scale(0.85, 0.85);
    actor.opacity = 160;
    journal(`[settleIcon] animating ${actor} (scale 0.85→1.0, opacity 160→255) duration ${duration}ms`);
    actor.ease({
        scale_x: 1,
        scale_y: 1,
        opacity: 255,
        duration: duration,
        mode: mode,
    });
}