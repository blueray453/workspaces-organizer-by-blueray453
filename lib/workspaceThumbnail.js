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

export class WorkspaceThumbnail extends St.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(workspace, settings) {
        super({
            style_class: 'workspace-thumbnail',
            x_expand: true,
            y_expand: true,
        });
        this._settings = settings;
        this.set_style(`min-width: ${settings.get_int('thumbnail-min-width')}px;`);

        this._workspace = workspace;
        this._windowsBox = new St.BoxLayout();
        this.set_child(this._windowsBox);

        this._orderStore = new WindowOrderStore(workspace);
        this._displayMode = new ThumbnailDisplayModeController(
            this._windowsBox,
            this._orderStore,
            this._settings,
            {
                onIconClicked: window => {
                    this._workspace.activate(0);
                    window.activate(0);
                },
            }
        );
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

    get workspace() {
        return this._workspace;
    }

    get workspaceIndex() {
        return this._workspace.index();
    }

    // Used by TitleBarMoveMonitor (native title-bar drags, not our DND
    // pipeline — no live drag actor to transplant, so the simpler
    // order-store-only path is correct here).
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

    // Delegates entirely to the coordinator — this class no longer knows
    // anything about order stores, display-mode transitions, or actor
    // transforms during a drop.
    acceptDrop(source, actor, x, y, time) {
        return WindowReorderDragController.acceptDrop(this, source, actor, time);
    }

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