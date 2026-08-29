# V3 DND actor-lifetime fix

## Root cause fixed
GNOME Shell's `DND.makeDraggable()` uses the delegate's `getDragActor()` as the temporary drag actor. With `restoreOnSuccess: false`, an accepted drop may destroy that drag actor after `acceptDrop()` returns.

The previous rework incorrectly allowed the canonical `WindowIconButton` to remain the DND drag actor. That meant the real display actor could disappear after a successful drop even though the actor registry still considered it protected.

## V3 change
`WindowIconButton` now provides:

- `getDragActor()` — returns a disposable `St.Bin` containing a `Clutter.Clone` of the icon child.
- `getDragActorSource()` — returns the canonical `WindowIconButton` for source-position tracking.

The real `WindowIconButton` is therefore never owned/destroyed by GNOME Shell's DND cleanup. It is only leased by `WindowActorRegistry` during the drag and reclaimed by the appropriate display after the model transition.

A small missing-braces bug in `WindowReorderDragController.acceptDrop()` was also corrected so destination metadata is only written for leased canonical actors.

## Validation
All JavaScript files pass `node --check`.
