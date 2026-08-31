import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

// A dragged source can be either one of our own WindowIconButtons (has
// `_window`) or a WindowSearchOverlay result row (has `realWindow`, a
// Meta.WindowActor). This normalizes both to the underlying Meta.Window.
export function getDraggedWindow(source) {
    if (!source)
        return null;
    if (source._window)
        return source._window;
    if (source.realWindow && typeof source.realWindow.get_meta_window === 'function')
        return source.realWindow.get_meta_window();
    return null;
}

// Shared DND.makeDraggable() wrapper for every reorderable icon in the
// extension (window icons, window-search result rows, pinned-app icons)
// so they all share the same drag-actor sizing and translucency instead
// of each call site repeating (and potentially drifting on) the same
// options. `iconSize` sets the cap on the drag actor's rendered size;
// `extraOptions` lets a caller add/override anything DND.makeDraggable
// accepts (e.g. `restoreOnSuccess`) without forking the shared defaults.
export function createReorderDraggable(actor, iconSize, extraOptions = {}) {
    return DND.makeDraggable(actor, {
        restoreOnSuccess: false,
        dragActorMaxSize: iconSize,
        dragActorOpacity: 178, // ≈ 0.70 alpha, matches .reorder-drag-source
        ...extraOptions,
    });
}