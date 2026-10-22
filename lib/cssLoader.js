// ===== FILE: ./lib/cssLoader.js =====
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

export function createCssLoader(name, build) {
    let file = null;
    const theme = () => St.ThemeContext.get_for_stage(global.stage).get_theme();
    return {
        apply() {
            try {
                const t = theme();
                if (file) t.unload_stylesheet(file);
                const f = Gio.File.new_for_path(
                    GLib.build_filenamev([GLib.get_user_cache_dir(), `${name}.css`]));
                f.replace_contents(new TextEncoder().encode(build()), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                t.load_stylesheet(f);
                file = f;
            } catch (e) {
                console.error(`[${name}] stylesheet apply failed: ${e.message}`);
            }
        },
        destroy() {
            try { if (file) theme().unload_stylesheet(file); } catch (e) { /* theme gone */ }
            file = null;
        },
    };
}
