import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Performs the model-level window move. It does not manipulate actors.
export const WorkspaceWindowMover = {
    move(window, targetThumbnail, insertIndex) {
        const targetWorkspace = targetThumbnail.workspace;
        const currentWorkspace = window.get_workspace();
        const targetStore = targetThumbnail._orderStore;

        if (currentWorkspace === targetWorkspace) {
            targetStore.reorderWindowToIndex(window, insertIndex);
            return;
        }

        // Record the user's requested position before Mutter emits the
        // target workspace's window-added signal.
        targetStore.setPendingInsertIndex(window, insertIndex);

        const monitorIndex = Main.layoutManager.findIndexForActor(targetThumbnail);
        if (monitorIndex !== window.get_monitor())
            window.move_to_monitor(monitorIndex);

        window.change_workspace(targetWorkspace);
    },
};
