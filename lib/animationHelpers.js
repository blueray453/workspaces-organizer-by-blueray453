import Clutter from 'gi://Clutter';

import { TimeoutDelay, SettleAnimationDuration } from './shellGlobals.js';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

/**
 * Fade in an actor from opacity 0 to 255.
 * Safe: skips if actor is invalid or not on stage.
 */
export function fadeInActor(actor, duration = TimeoutDelay, mode = Clutter.AnimationMode.EASE_OUT_QUAD) {
    if (!actor) {
        journal('[fadeInActor] called with null actor');
        return;
    }
    try {
        // If the actor isn't on stage, it's likely being destroyed – skip
        if (!actor.get_stage()) {
            journal('[fadeInActor] actor not on stage, skipping');
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
    } catch (e) {
        journal(`[fadeInActor] error: ${e}`);
    }
}

/**
 * "Settle" an icon: scale from 0.85 → 1.0, opacity 160 → 255.
 * Safe: skips if actor is invalid or not on stage.
 */
export function settleIcon(actor, duration = SettleAnimationDuration, mode = Clutter.AnimationMode.EASE_OUT_QUAD) {
    if (!actor) {
        journal('[settleIcon] called with null actor');
        return;
    }
    try {
        const stage = actor.get_stage();
        if (!stage) {
            journal('[settleIcon] actor not on stage, skipping');
            return;
        }
        journal(`[settleIcon] actor on stage, applying animation`);
        // Remove any leftover drag styling – ignore errors
        try {
            actor.remove_style_class_name('reorder-drag-source');
        } catch (e) {
            // actor may not have the style or may be destroyed
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
    } catch (e) {
        journal(`[settleIcon] error: ${e}`);
    }
}