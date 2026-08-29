# Workspace drag architecture rework

## What changed

The original `setSuppressSync()` / manual `sync()` approach has been removed.
The redesigned implementation keeps GNOME/Mutter signals active at all times and
solves the race through actor ownership instead of signal suppression.

### Actor lifecycle

A canonical `WindowIconButton` can be in one of these states:

1. **Normal** — owned by its workspace display.
2. **Leased** — owned by the active DND operation.
3. **Handoff** — DND has ended successfully, but the destination display has not
   yet claimed the actor.

An actor in the leased or handoff state cannot be destroyed. Once the destination
(or the original workspace after a cancelled/failed move) claims it, normal display
ownership resumes.

## Main components

- `WindowOrderStore`: workspace membership and ordered model only.
- `ThumbnailDisplayModeController`: reconciles the actor tree from the model and
  manages direct/collection presentation.
- `WindowActorRegistry`: canonical actor ownership and drag handoff protection.
- `WorkspaceWindowMover`: performs `Meta.Window` monitor/workspace changes and
  records the requested insertion index.
- `WindowReorderDragController`: drag lifecycle, insertion calculation, and drop
  acceptance only.

## Important safety properties

### Same-workspace reorder

The order store changes immediately and emits normally. While the drag is active,
the icon is leased, so reconciliation cannot destroy/reparent it. On `drag-end`,
the actor enters handoff, then the display claims and places it according to the
new model order.

### Cross-workspace move

The target insertion index is recorded before `change_workspace()`. Source and
target order stores continue to receive their normal signals. The source removes
its local display ownership without destroying the leased actor. The target claims
the same actor when the model confirms that the window belongs to the target
workspace.

The handoff state is deliberately retained until claimed. This prevents a subtle
ordering bug where the source display could process the release before the target
display and destroy the shared actor first.

### Fast drops

The insertion index is recomputed from the current pointer at drop time, rather
than relying on the last drag-motion event.

### Direct/collection mode changes

Display reconciliation uses the current model count. A leased/handoff actor is
never destroyed during the transition. If the final destination is collection
mode, the actor is claimed and destroyed only after ownership is transferred.

### Cancellation / failed move

A drag that ends without a destination has no handoff record. The original display
reconciles normally and regains the actor without timers or rollback logic.

## Removed APIs

The executable source no longer uses:

- `setSuppressSync()`
- `insertWindowImmediate()`
- `releasePreview()`
- `adoptPreview()`
- `syncChildOrder()`
- drag-controller calls to display `sync()`
- direct mutation of `_windowPreviews` by the drag controller

The existing `WindowOrderStore` geometry-settling timeout remains only for ordinary
new-window icon construction; it is not used as a drag synchronization mechanism.
