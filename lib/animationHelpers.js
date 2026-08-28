import Clutter from 'gi://Clutter';
import { SettleAnimationDuration } from './shellGlobals.js';
import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

/**
 * Applies a "settle" animation to an actor (scale up & fade in).
 * Removes any drag-source styling and eases from 0.85/160 to 1.0/255.
 */
export function settleIcon(actor, duration = SettleAnimationDuration, mode = Clutter.AnimationMode.EASE_OUT_QUAD) {
    if (!actor) {
        journal('[settleIcon] called with null actor');
        return;
    }

    // Remove any leftover drag styling
    try {
        actor.remove_style_class_name('reorder-drag-source');
    } catch (e) {
        // actor may already be destroyed
    }

    // Cancel any ongoing transitions
    actor.remove_all_transitions();

    // Set initial state
    actor.set_pivot_point(0.5, 0.5);
    actor.set_scale(0.85, 0.85);
    actor.opacity = 160;

    journal(`[settleIcon] animating ${actor} (scale 0.85→1.0, opacity 160→255) duration ${duration}ms`);

    // Ease to final
    actor.ease({
        scale_x: 1,
        scale_y: 1,
        opacity: 255,
        duration: duration,
        mode: mode,
    });
}
