import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { WindowTracker, Display } from './shellGlobals.js';

import { createLogger } from '../logger.js';

const journal = createLogger(import.meta.url);

// ==================== WINDOW ACTION MENU ====================
// The right-click context menu for a single window icon: activate, close,
// close-others-of-same-app, and app-specific quick actions. The only
// class that knows what's in this menu.
export class WindowActionMenu {
    constructor(window, anchorActor) {
        this._window = window;
        this._anchor = anchorActor;
        this._menu = null;
        this._menuManager = null;
    }

    open() {
        if (this._menu) {
            this._menu.open(true);
            return;
        }

        const menu = new PopupMenu.PopupMenu(this._anchor, 0.0, St.Side.TOP);
        menu.box.add_style_class_name('workspace-context-menu');
        this._menu = menu;
        this._menuManager = new PopupMenu.PopupMenuManager(this._anchor);
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        const win = this._window;
        menu.addAction(`Activate ${win.title}`, () => {
            win.get_workspace().activate_with_focus(win, 0);
        });

        menu.addAction(`Close ${win.title}`, () => {
            win.delete(0);
        });

        menu.addAction(`Close Except ${win.title}`, () => {
            const targetWmClass = win.get_wm_class();
            const windowsToClose = Display.get_tab_list(
                Meta.TabList.NORMAL,
                win.get_workspace()
            ).filter(w =>
                w !== win &&
                w.get_wm_class() === targetWmClass &&
                w.get_wm_class_instance() !== 'file_progress'
            );
            const currentTime = global.get_current_time();
            for (const window of windowsToClose) {
                journal(`Closing window: ${window.get_title()}`);
                window.delete(currentTime);
            }
        });

        const app = WindowTracker.get_window_app(win);
        const appInfo = app?.get_app_info();
        const actions = appInfo?.list_actions();
        if (actions && actions.length > 0) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            actions.forEach(action => {
                menu.addAction(`${appInfo.get_action_name(action)}`, () => {
                    app.launch_action(action, 0, -1);
                });
            });
        }

        menu.open(true);
        if (menu._boxPointer)
            menu._boxPointer.translation_y = -35;
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