import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { WorkspaceManager } from './shellGlobals.js';
import { WorkspaceThumbnailRegistry } from './workspaceThumbnailRegistry.js';
import { WindowReorderDragController } from './windowReorderDragController.js';
import { getDraggedWindow } from './dragHelpers.js';
import { WindowOrderStore } from './windowOrderStore.js';
import { ThumbnailDisplayModeController } from './thumbnailDisplayModeController.js';
import { ThumbnailActionMenu } from './thumbnailActionMenu.js';

// ==================== WORKSPACE THUMBNAIL (coordinator) ====================
// Represents a single workspace in the panel indicator. Owns the button
// actor, DND-target protocol methods (delegating math to
// WindowReorderDragController), and holds one WindowOrderStore + one
// ThumbnailDisplayModeController — it does not itself track window order
// or build icons.
export class WorkspaceThumbnail extends St.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(workspace) {
        super({
            style_class: 'workspace-thumbnail',
            x_expand: true,
            y_expand: true,
        });

        this._workspace = workspace;
        this._windowsBox = new St.BoxLayout();
        this.set_child(this._windowsBox);

        this._orderStore = new WindowOrderStore(workspace);
        this._displayMode = new ThumbnailDisplayModeController(this._windowsBox, this._orderStore, {
            onIconClicked: window => {
                this._workspace.activate(0);
                window.activate(0);
            },
        });
        this._actionMenu = new ThumbnailActionMenu(workspace, this);

        WorkspaceThumbnailRegistry.register(this);

        this._delegate = this;

        this._wsChangedId = WorkspaceManager.connect('workspace-switched', () => {
            this._actionMenu.close();
        });

        this.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_PRIMARY)
                this._workspace.activate(0);
            if (button === Clutter.BUTTON_SECONDARY)
                this._actionMenu.open();
            return Clutter.EVENT_STOP;
        });
    }

    // ---- public surface used by TitleBarMoveMonitor and WindowIconButton ----
    get workspace() {
        return this._workspace;
    }

    get workspaceIndex() {
        return this._workspace.index();
    }

    moveWindowHere(window, insertIndex = null) {
        const wasSameWorkspace = window.get_workspace() === this._workspace;

        const monitorIndex = Main.layoutManager.findIndexForActor(this);
        if (monitorIndex !== window.get_monitor())
            window.move_to_monitor(monitorIndex);

        if (insertIndex !== null && !wasSameWorkspace)
            this._orderStore.setPendingInsertIndex(window, insertIndex);

        window.change_workspace(this._workspace);

        if (insertIndex !== null && wasSameWorkspace)
            this._orderStore.reorderWindowToIndex(window, insertIndex);
    }

    syncChildOrder() {
        this._displayMode.syncChildOrder();
    }

    cleanupSources() {
        this._orderStore.cleanupSources();
    }

    // ==================== DND TARGET PROTOCOL ====================
    // (Called by dnd.js via `_delegate`.)
    handleDragOver(source, actor, x, y, time) {
        const draggedWindow = getDraggedWindow(source);
        if (!draggedWindow)
            return DND.DragMotionResult.CONTINUE;

        if (this._displayMode.mode !== 'direct')
            return DND.DragMotionResult.MOVE_DROP;

        const [pointerX] = global.get_pointer();
        const insertion = WindowReorderDragController.computeInsertionFromPointer(
            draggedWindow, this._orderStore.order, pointerX, this._windowsBox);
        WindowReorderDragController.updatePlaceholder(this._windowsBox, insertion.insertIndex);

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, actor, x, y, time) {
        const draggedWindow = getDraggedWindow(source);
        if (!draggedWindow)
            return false;

        const last = WindowReorderDragController.getLastInsertion();
        const insertIndex = last && last.box === this._windowsBox ? last.index : null;
        this.moveWindowHere(draggedWindow, insertIndex);
        WindowReorderDragController.clearPlaceholder();
        return true;
    }

    // Icon-to-icon hover is mathematically identical to hovering empty
    // space in the same box — both just need "pointerX vs this box's
    // snapshot" — so route through the same, snapshot-stabilized path
    // instead of re-measuring the hovered icon's live (placeholder-shifted)
    // position, which previously caused visible flicker.
    handleWindowDragOver(draggedWindow, targetPreview, x, y, time) {
        if (!draggedWindow || targetPreview?.window === draggedWindow)
            return DND.DragMotionResult.MOVE_DROP;
        return this.handleDragOver({ _window: draggedWindow }, null, x, y, time);
    }

    acceptWindowDrop(draggedWindow, targetPreview, x, y, time) {
        if (!draggedWindow)
            return false;
        return this.acceptDrop({ _window: draggedWindow }, null, x, y, time);
    }

    destroy() {
        if (this._wsChangedId) {
            WorkspaceManager.disconnect(this._wsChangedId);
            this._wsChangedId = null;
        }
        this._actionMenu.destroy();
        WindowReorderDragController.clearIfRelated(this._windowsBox);
        WorkspaceThumbnailRegistry.unregister(this);

        this._orderStore.destroy();
        this._displayMode.destroy();

        super.destroy();
    }
}