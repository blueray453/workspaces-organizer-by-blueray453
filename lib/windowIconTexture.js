import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';

// ==================== SHARED WINDOW ICON RESOLUTION ====================
// Single place that decides "what icon represents this window": the
// running app's icon, falling back to the window's own gicon, falling
// back to a generic symbolic icon. Two shapes are needed by callers —
// a ready-to-place actor (WindowIconRenderer, inside windowIconButton.js)
// and a raw Gio.Icon (search-overlay result rows + drag-thumbnail clone,
// in windowSearchOverlay.js) — both resolve through the same app/gicon
// lookup so every surface agrees on the icon.

function resolveApp(window) {
    return Shell.WindowTracker.get_default().get_window_app(window) ||
        Shell.AppSystem.get_default().lookup_app(window.get_wm_class());
}

export function getWindowAppIcon(window) {
    const app = resolveApp(window);
    if (app && app.get_app_info().get_icon())
        return app.get_icon();
    return window.get_gicon() || new Gio.ThemedIcon({ name: 'applications-system-symbolic' });
}

export function createWindowIconTexture(window, iconSize) {
    const app = resolveApp(window);
    if (app && app.get_app_info().get_icon())
        return app.create_icon_texture(iconSize);

    const icon = new St.Icon({ gicon: getWindowAppIcon(window), style_class: 'popup-menu-icon' });
    return St.TextureCache.get_default().load_gicon(null, icon, iconSize);
}

// Shared by WindowIconButton's WindowActionMenu (pin/unpin) and DrunMode
// in the other extension. Given a window, resolves the Shell.App it
// belongs to (or null if none — e.g. a window with no .desktop entry).
export function getWindowApp(window) {
    return resolveApp(window);
}