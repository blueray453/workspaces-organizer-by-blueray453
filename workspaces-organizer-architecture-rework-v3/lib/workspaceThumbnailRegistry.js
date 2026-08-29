export const WorkspaceThumbnailRegistry = {
    _thumbnails: new Set(),
    register(thumb) { this._thumbnails.add(thumb); },
    unregister(thumb) { this._thumbnails.delete(thumb); },
    getAll() { return [...this._thumbnails]; },
    getForWorkspace(workspace) {
        for (const thumbnail of this._thumbnails)
            if (thumbnail.workspace === workspace) return thumbnail;
        return null;
    },
    hideAllNameHints() {
        for (const thumbnail of this._thumbnails)
            thumbnail.hideNameHint?.();
    },
};
