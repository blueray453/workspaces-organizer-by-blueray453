/**
 * Make `prev` match `desired` and return the new Map.
 *
 *   prev      Map<key, value>  what currently exists
 *   desired   Map<key, spec>   what should exist; spec is passed to create()
 *   create    (spec, key) => value
 *   destroy   (value, key) => void
 *   stale     optional (value) => bool; true means destroy and recreate
 *
 * Survivors are returned untouched (same object identity). Order of
 * operations: stale teardown, then creation, then removal of the gone, so
 * a failure in create() can't leave half-destroyed state behind.
 */
export function reconcile(prev, desired, create, destroy, { stale = null } = {}) {
    const next = new Map();

    for (const [key, spec] of desired) {
        let value = prev.get(key);
        if (value !== undefined && stale?.(value)) {
            destroy(value, key);
            prev.delete(key);   // so the removal pass below skips it
            value = undefined;
        }
        next.set(key, value !== undefined ? value : create(spec, key));
    }

    for (const [key, value] of prev)
        if (!next.has(key)) destroy(value, key);

    return next;
}
