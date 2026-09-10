export class WorkspaceThumbnailRegistry {
    static _thumbnails = new Set();

    static register(thumb) { this._thumbnails.add(thumb); }
    static unregister(thumb) { this._thumbnails.delete(thumb); }
    static getAll() { return [...this._thumbnails]; }

    static getForWorkspace(workspace) {
        for (const thumbnail of this._thumbnails)
            if (thumbnail.workspace === workspace) return thumbnail;
        return null;
    }

    static hideAllNameHints() {
        for (const thumbnail of this._thumbnails)
            thumbnail.hideNameHint?.();
    }

    static hideAllGhosts() {
        for (const thumbnail of this._thumbnails)
            thumbnail.hideGhost?.();
    }

    static hideAllGhostsExcept(keep) {
        for (const thumbnail of this._thumbnails)
            if (thumbnail !== keep)
                thumbnail.hideGhost?.();
    }
}