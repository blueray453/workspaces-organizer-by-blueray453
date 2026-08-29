// ==================== WINDOW ACTOR REGISTRY ====================
// Tracks the canonical WindowIconButton for each Meta.Window and protects it
// during DND handoff. A drag has two ownership states:
//   leased  -> DND owns the actor
//   handoff -> DND ended, but a display still has to claim the actor
// Neither state permits destruction. The handoff is cleared only when a
// display explicitly claims the actor.
class WindowActorRegistryImpl {
    constructor() {
        this._actors = new Map();        // window -> actor
        this._leases = new Map();        // window -> actor
        this._handoffs = new Map();      // window -> { actor, destination, index }
        this._releaseListeners = new Set();
    }

    register(window, actor) {
        const existing = this._actors.get(window);
        if (existing && existing !== actor)
            throw new Error(`Actor already registered for window: ${window.title}`);
        this._actors.set(window, actor);
    }

    get(window) {
        return this._actors.get(window) ?? null;
    }

    unregister(window, actor) {
        if (this._actors.get(window) !== actor)
            return;
        if (this.isProtected(window, actor))
            return;
        this._actors.delete(window);
    }

    acquire(window, actor) {
        if (this._actors.get(window) !== actor)
            throw new Error(`Cannot lease unregistered actor for window: ${window.title}`);

        const existing = this._leases.get(window);
        if (existing && existing !== actor)
            throw new Error(`Window already leased: ${window.title}`);

        this._handoffs.delete(window);
        this._leases.set(window, actor);
    }

    setDestination(window, workspace) {
        if (!this.isLeased(window))
            throw new Error(`Cannot set drag destination for unleased window: ${window.title}`);

        this._leases.set(window, this._leases.get(window));
        const current = this._handoffs.get(window) ?? {
            actor: this._leases.get(window),
            destination: null,
            index: null,
        };
        current.destination = workspace;
        this._handoffs.set(window, current);
    }

    setDestinationIndex(window, index) {
        const leaseActor = this._leases.get(window);
        if (!leaseActor)
            throw new Error(`Cannot set drag destination index for unleased window: ${window.title}`);

        const current = this._handoffs.get(window) ?? {
            actor: leaseActor,
            destination: null,
            index: null,
        };
        current.index = index;
        this._handoffs.set(window, current);
    }

    getDestination(window) {
        return this._handoffs.get(window) ?? null;
    }

    release(window, actor) {
        if (this._leases.get(window) !== actor)
            return;

        const pending = this._handoffs.get(window);
        this._leases.delete(window);

        // A successful drop has a destination and therefore enters the
        // protected handoff state. A cancelled/failed drop has no destination
        // and simply returns ownership to the display on its next reconcile.
        if (!pending?.destination) {
            this._handoffs.delete(window);
            for (const listener of this._releaseListeners)
                listener(window, actor, null);
            return;
        }

        const handoff = {
            actor,
            destination: pending.destination,
            index: pending.index,
        };
        this._handoffs.set(window, handoff);

        for (const listener of this._releaseListeners)
            listener(window, actor, handoff);
    }

    claim(window, actor) {
        const handoff = this._handoffs.get(window);
        if (!handoff || handoff.actor !== actor)
            return false;

        this._handoffs.delete(window);
        return true;
    }

    isLeased(window, actor = null) {
        const leased = this._leases.get(window);
        return leased !== undefined && (actor === null || leased === actor);
    }

    isProtected(window, actor = null) {
        const leased = this._leases.get(window);
        if (leased !== undefined && (actor === null || leased === actor))
            return true;

        const handoff = this._handoffs.get(window);
        return !!handoff && (actor === null || handoff.actor === actor);
    }

    onReleased(callback) {
        this._releaseListeners.add(callback);
        return () => this._releaseListeners.delete(callback);
    }

    destroyWindow(window) {
        const actor = this._actors.get(window);
        if (!actor || this.isProtected(window, actor))
            return;

        this._actors.delete(window);
        try {
            if (actor.get_parent())
                actor.get_parent().remove_child(actor);
            actor.destroy();
        } catch (e) {
            // Best-effort teardown during Shell shutdown.
        }
    }

    clear() {
        this._actors.clear();
        this._leases.clear();
        this._handoffs.clear();
        this._releaseListeners.clear();
    }
}

export const WindowActorRegistry = new WindowActorRegistryImpl();
