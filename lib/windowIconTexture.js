import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';

// ==================== SHARED WINDOW ICON TEXTURE ====================
// Builds the app-icon actor for a window: the running app's icon if
// known, otherwise the window's own gicon, falling back to a generic
// symbolic icon. Used by WindowIconRenderer (panel icons — which also
// track icon-geometry separately) and by WindowSearchOverlay (result-row
// icons and the DND drag-thumbnail clone). Keeping this in one place
// means every surface agrees on "what icon represents this window".
export function createWindowIconTexture(window, iconSize) {
    const app = Shell.WindowTracker.get_default().get_window_app(window) ||
        Shell.AppSystem.get_default().lookup_app(window.get_wm_class());

    if (app && app.get_app_info().get_icon())
        return app.create_icon_texture(iconSize);

    let gicon = window.get_gicon();
    if (!gicon)
        gicon = new Gio.ThemedIcon({ name: 'applications-system-symbolic' });

    const icon = new St.Icon({
        gicon,
        style_class: 'popup-menu-icon',
    });
    return St.TextureCache.get_default().load_gicon(null, icon, iconSize);
}
