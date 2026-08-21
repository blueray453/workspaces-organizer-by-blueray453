import Gio from 'gi://Gio';
import St from 'gi://St';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

// ==================== WINDOW ICON RENDERER ====================
// Owns rendering the app icon texture into a parent actor and keeping it
// in sync with wm-class/mapped changes, plus reporting the icon's screen
// geometry back to the compositor (used for minimize/restore animations).
// The only class that touches icon textures.
export class WindowIconRenderer {
    constructor(parentActor, window) {
        this._parent = parentActor;
        this._window = window;
        this._iconSize = 96;

        this._updateIcon();
        this._wmClassChangedId = this._window.connect('notify::wm-class', this._updateIcon.bind(this));
        this._mappedId = this._window.connect('notify::mapped', this._updateIcon.bind(this));
    }

    get iconSize() {
        return this._iconSize;
    }

    setIconSize(size) {
        if (size !== this._iconSize) {
            this._iconSize = size;
            this._updateIcon();
        }
    }

    _updateIcon() {
        const app = Shell.WindowTracker.get_default().get_window_app(this._window) ||
            Shell.AppSystem.get_default().lookup_app(this._window.get_wm_class());
        let iconActor = null;
        if (app && app.get_app_info().get_icon()) {
            iconActor = app.create_icon_texture(this._iconSize);
            this._parent.set_child(iconActor);
        } else {
            let gicon = this._window.get_gicon();
            if (!gicon)
                gicon = new Gio.ThemedIcon({ name: 'applications-system-symbolic' });
            const icon = new St.Icon({
                gicon: gicon,
                style_class: 'popup-menu-icon',
            });
            iconActor = St.TextureCache.get_default().load_gicon(null, icon, this._iconSize);
            this._parent.set_child(iconActor);
        }

        const signalId = iconActor.connect('stage-views-changed', (actor) => {
            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = iconActor.get_transformed_position();
            [rect.width, rect.height] = iconActor.get_transformed_size();
            this._window.set_icon_geometry(rect);
            iconActor.disconnect(signalId);
        });
    }

    destroy() {
        if (this._wmClassChangedId && this._window) {
            this._window.disconnect(this._wmClassChangedId);
            this._wmClassChangedId = null;
        }
        if (this._mappedId && this._window) {
            this._window.disconnect(this._mappedId);
            this._mappedId = null;
        }
        // The icon actor is a child of _parent; it's destroyed with it.
    }
}