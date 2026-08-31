import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';

// Single point of contact with the shell's menu-related modules
// (popupMenu.js, panelMenu.js, appMenu.js). Everything else in the
// extension imports menu-related things from here instead of importing
// those resource paths directly.
export const PopupMenuManager = PopupMenu.PopupMenuManager;
export const PopupSeparatorMenuItem = PopupMenu.PopupSeparatorMenuItem;
export const PanelMenuButton = PanelMenu.Button;
export { AppMenu };

// Shared "top-anchored context menu" builder for the two simple
// right-click menus in the extension (window icon, workspace thumbnail).
// Both want the same style class, anchor side, and manager/mount setup —
// this keeps them from drifting apart. Returns { menu, menuManager } so
// the caller can still add its own items and call menu.open(true).
export function createContextMenu(anchorActor, { styleClass = 'workspace-context-menu' } = {}) {
    const menu = new PopupMenu.PopupMenu(anchorActor, 0.0, St.Side.TOP);
    menu.box.add_style_class_name(styleClass);

    const menuManager = new PopupMenu.PopupMenuManager(anchorActor);
    menuManager.addMenu(menu);
    Main.uiGroup.add_child(menu.actor);

    return { menu, menuManager };
}
