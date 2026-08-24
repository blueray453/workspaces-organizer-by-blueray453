// ==================== WORKSPACE THUMBNAIL REGISTRY ====================
// Tracks all live WorkspaceThumbnail actors so native (title-bar) window
// drags AND our own drag-and-drop transplant logic can resolve a
// workspace to its on-screen thumbnail. Singleton.
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
    getForWorkspace(workspace) {
        for (const thumbnail of this._thumbnails) {
            if (thumbnail.workspace === workspace)
                return thumbnail;
        }
        return null;
    },
};