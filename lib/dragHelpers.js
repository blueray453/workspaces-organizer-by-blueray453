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