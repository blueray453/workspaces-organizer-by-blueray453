import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Display } from './shellGlobals.js';

import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

// ==================== THUMBNAIL ACTION MENU ====================
// The right-click context menu on a WorkspaceThumbnail itself (as
// opposed to WindowActionMenu, which is per-icon): bulk close actions
// scoped to "this workspace" vs "everywhere else". Extracted so changing
// this menu never requires touching WorkspaceThumbnail.
export class ThumbnailActionMenu {
    constructor(workspace, anchorActor) {
        this._workspace = workspace;
        this._anchor = anchorActor;
        this._menu = null;
        this._menuManager = null;
    }

    open() {
        const windows = Display.get_tab_list(Meta.TabList.NORMAL, this._workspace);
        const windowCount = windows.length;

        const menu = new PopupMenu.PopupMenu(this._anchor, 0.0, St.Side.TOP);
        menu.box.add_style_class_name('workspace-context-menu');
        this._menu = menu;
        this._menuManager = new PopupMenu.PopupMenuManager(this._anchor);
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        menu.addAction('Close all windows on all workspaces', () => {
            const windowsToClose = Display.get_tab_list(Meta.TabList.NORMAL, null);
            const currentTime = global.get_current_time();
            for (const window of windowsToClose) {
                journal(`Closing window: ${window.get_title()}`);
                window.delete(currentTime);
            }
        });

        if (windowCount > 0) {
            menu.addAction(
                `Close all windows except workspace ${this._workspace.index()}`,
                () => {
                    const windowsToClose = Display.get_tab_list(Meta.TabList.NORMAL, null)
                        .filter(w => w.get_workspace() !== this._workspace);
                    const currentTime = global.get_current_time();
                    for (const window of windowsToClose) {
                        journal(`Closing window: ${window.get_title()}`);
                        window.delete(currentTime);
                    }
                }
            );
            menu.addAction(
                `Close all windows on workspace ${this._workspace.index()}`,
                () => {
                    const currentTime = global.get_current_time();
                    for (const window of windows) {
                        journal(`Closing window: ${window.get_title()}`);
                        window.delete(currentTime);
                    }
                }
            );
        }

        menu.open(true);
    }

    close() {
        if (this._menu) {
            this._menu.close();
            this._menu = null;
            this._menuManager = null;
        }
    }

    destroy() {
        this.close();
    }
}