// ==================== WORKSPACE THUMBNAIL REGISTRY ====================
// Tracks all live WorkspaceThumbnail actors so native (title-bar) window
// drags can be hit-tested against them on drop, independent of our own
// St/Clutter DND sessions. Singleton — only one exists for the extension.
export const WorkspaceThumbnailRegistry = {
    _thumbnails: new Set(),
    register(thumb) {
        this._thumbnails.add(thumb);
    },
    unregister(thumb) {
        this._thumbnails.delete(thumb);
    },
    getAll() {
        return [...this._thumbnails];
    },
};