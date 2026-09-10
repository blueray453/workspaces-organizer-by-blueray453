// Ephemeral state for the ongoing window-icon reorder drag, if any.
//
// The drag source sets `ghostTemplate` on drag-begin and clears it on
// drag-end. WorkspaceThumbnail reads it when drawing the ghost placeholder.
export class DragSession {
    static ghostTemplate = null;
}