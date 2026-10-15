import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

/**
 * DECLARATIVE UI. Pure builders: data in, actors out.
 *
 * No `connect`, no `GLib`, no state, no chrome parenting. If a builder has
 * a sub-actor the caller needs (a close button, a child box), it returns it.
 * Everything that wires events or mutates an actor after creation lives in
 * interactions.js.
 */

// ==================== app / icon resolution ====================
function resolveApp(window) {
    return Shell.WindowTracker.get_default().get_window_app(window)
        || Shell.AppSystem.get_default().lookup_app(window.get_wm_class());
}

export function getWindowApp(window) { return resolveApp(window); }

export function getWindowAppIcon(window) {
    const app = resolveApp(window);
    if (app?.get_app_info()?.get_icon()) return app.get_icon();
    return window.get_gicon() || new Gio.ThemedIcon({ name: 'applications-system-symbolic' });
}

function createWindowIconTexture(window, iconSize) {
    const app = resolveApp(window);
    if (app?.get_app_info()?.get_icon()) return app.create_icon_texture(iconSize);
    const icon = new St.Icon({ gicon: getWindowAppIcon(window), style_class: 'popup-menu-icon' });
    return St.TextureCache.get_default().load_gicon(null, getWindowAppIcon(window), iconSize);
}

// ==================== drag visuals ====================
export function createGhostIcon(gicon, size) {
    const ghost = new St.Bin({ style_class: 'drag-placeholder-icon', width: size, height: size });
    ghost.opacity = 140;
    if (gicon) ghost.set_child(new St.Icon({ gicon, icon_size: size }));
    return ghost;
}

export function createDragActor(gicon, size) {
    const bin = new St.Bin({ style_class: 'reorder-drag-source', width: size, height: size });
    bin.opacity = 178;
    if (gicon) bin.set_child(new St.Icon({ gicon, icon_size: size }));
    return bin;
}

// ==================== indicator widgets ====================
export function createToolbarButton(iconName, size, accessibleName) {
    return new St.Button({
        style_class: 'workspace-toolbar-button',
        accessible_name: accessibleName,
        can_focus: true, track_hover: true,
        child: new St.Icon({ icon_name: iconName, icon_size: size }),
    });
}

export function createWorkspaceNameLabel(text, fontSizePx) {
    const label = new St.Label({
        style_class: 'workspace-name-label',
        y_expand: true, y_align: Clutter.ActorAlign.CENTER, text,
    });
    label.set_style(`font-size: ${fontSizePx}px;`);
    return label;
}

export function createThumbnail({ minWidth, active }) {
    const actor = new St.Button({ style_class: 'workspace-thumbnail', x_expand: true, y_expand: true });
    actor.set_style(`min-width: ${minWidth}px;`);
    if (active) actor.add_style_class_name('active');
    const box = new St.BoxLayout();
    actor.set_child(box);
    return { actor, box };
}

export function createOverflowButton(count) {
    const actor = new St.Button({
        style_class: 'workspace-thumbnail-collection-icon',
        reactive: true, track_hover: true, can_focus: true,
    });
    actor.set_child(new St.Label({
        style_class: 'collection-icon-label',
        text: `▱ ${count}`,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    return actor;
}

export function createWindowIconActor(window, iconSize) {
    const actor = new St.Button({
        style_class: 'window-preview-icon',
        reactive: true, track_hover: true,
    });
    const icon = createWindowIconTexture(window, iconSize);
    actor.set_child(icon);
    return { actor, icon };
}

// ==================== overlay chrome ====================
export function computeOverlayLayout(monitor) {
    const margin = 40, entryHeight = 80, entryGap = 20;
    const panelWidth = monitor.width - margin * 2;
    const panelX = monitor.x + margin;
    const entryY = monitor.y + margin;
    const panelTop = entryY + entryHeight + entryGap;
    const panelHeight = monitor.height - (panelTop - monitor.y) - margin;
    const resultsWidth = Math.round(panelWidth * 0.32);
    const previewWidth = panelWidth - resultsWidth - 20;
    return { monitor, margin, entryHeight, entryGap, panelWidth, panelX, entryY, panelTop, panelHeight, resultsWidth, previewWidth };
}

export function createOverlayContainer(monitor) {
    return new St.Widget({
        style_class: 'window-collection-overlay',
        reactive: true, can_focus: true,
        x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
    });
}

export function createSearchEntry({ x, y, width, height, hint, fontSize }) {
    const entry = new St.Entry({
        style_class: 'collection-search-entry',
        hint_text: hint, can_focus: true, x, y, width, height,
    });
    entry.set_style(`font-size: ${fontSize}pt;`);
    return entry;
}

export function createResultsScroll({ x, y, width, height }) {
    const scroll = new St.ScrollView({ style_class: 'collection-results-scroll', x, y, width, height });
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    const box = new St.BoxLayout({ style_class: 'collection-results-box', vertical: true, x_expand: true });
    scroll.set_child(box);
    return { scroll, box };
}

export function createPreviewBox({ x, y, width, height, vertical }) {
    return new St.BoxLayout({ style_class: 'collection-preview-box', vertical, x, y, width, height });
}

export function createResultRow({ icon, label, iconSize, fontSize, pinned = false, focused = false }) {
    const actor = new St.Button({
        style_class: 'collection-result-item',
        x_expand: true, x_align: Clutter.ActorAlign.START, track_hover: true, reactive: true,
    });
    actor.set_style(`font-size: ${fontSize}pt;`);
    if (focused) actor.add_style_class_name('collection-result-item-focused');

    const row = new St.BoxLayout({ vertical: false, x_expand: true });
    if (icon) {
        row.add_child(new St.Icon({
            gicon: icon, style_class: 'collection-result-icon',
            icon_size: iconSize, y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    row.add_child(new St.Label({ text: label, x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
    if (pinned) {
        row.add_child(new St.Label({
            text: '📌', style_class: 'app-pin-marker', y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    actor.set_child(row);
    return actor;
}

export function createPinnedBar(height) {
    const box = new St.BoxLayout({
        style_class: 'dmenu-pinned-bar',
        vertical: false, x_expand: true, y_expand: false, height,
        x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER,
        reactive: true,
    });
    box.hide();
    return box;
}

export function createPinnedIcon(gicon, iconSize) {
    return new St.Button({
        style_class: 'dmenu-pinned-icon',
        reactive: true, can_focus: true, track_hover: true,
        child: new St.Icon({ gicon, icon_size: iconSize }),
    });
}

// ==================== clone preview ====================
const PREVIEW = { TITLE_MIN: 40, TITLE_MAX: 100, TITLE_FRACTION: 0.2 };

export function createClonePreview(window, targetHeight, options = {}) {
    if (!window) return null;
    const windowActor = window.get_compositor_private();
    if (!windowActor) return null;

    const frame = window.get_frame_rect();
    const buffer = window.get_buffer_rect();
    if (frame.height === 0) return null;

    const width = targetHeight * (frame.width / frame.height);
    const scale = targetHeight / frame.height;
    const left = (frame.x - buffer.x) * scale;
    const top = (frame.y - buffer.y) * scale;
    const right = ((buffer.x + buffer.width) - (frame.x + frame.width)) * scale;
    const bottom = ((buffer.y + buffer.height) - (frame.y + frame.height)) * scale;

    const inner = new St.BoxLayout({
        style_class: 'collection-preview-inner',
        width, height: targetHeight, clip_to_allocation: true,
    });

    const clone = new Clutter.Clone({
        source: windowActor,
        width: width + left + right,
        height: targetHeight + top + bottom,
    });
    clone.set_position(-left, -top);

    const overlay = new Clutter.Actor();
    overlay.add_child(clone);
    inner.add_child(overlay);

    if (options.showTitle !== false) {
        const raw = window.get_title();
        const text = raw && raw.trim() ? raw : 'Untitled';
        const titleHeight = Math.min(PREVIEW.TITLE_MAX,
            Math.max(PREVIEW.TITLE_MIN, targetHeight * PREVIEW.TITLE_FRACTION));
        const title = new St.Label({
            style_class: 'clone-title-overlay', text,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        title.clutter_text.set_y_align(Clutter.ActorAlign.CENTER);
        title.clutter_text.set_line_wrap(true);
        title.set_size(width, titleHeight);
        title.set_position(0, (targetHeight - titleHeight) / 2);
        overlay.add_child(title);
    }

    let closeButton = null;
    if (options.closeButtonSize) {
        const size = options.closeButtonSize;
        closeButton = new St.Button({
            style_class: 'window-close-button',
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: size }),
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START,
            reactive: true,
        });
        closeButton.set_position(width - (options.closeButtonOffsetX ?? (size + 14)),
            options.closeButtonOffsetY ?? 10);
        overlay.add_child(closeButton);
    }

    if (!options.wrapperStyleClass)
        return { actor: inner, inner, overlay, closeButton, width, height: targetHeight };

    const wrapper = new St.BoxLayout({
        style_class: options.wrapperStyleClass,
        reactive: true, track_hover: true,
    });
    wrapper.add_child(inner);
    return { actor: wrapper, wrapper, inner, overlay, closeButton, width, height: targetHeight };
}

// ==================== app preview ====================
export function createAppPreview(item, settings, previewWidth) {
    const wrapper = new St.BoxLayout({
        vertical: true, x_expand: true, y_expand: true,
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
    });

    wrapper.add_child(new St.Icon({
        gicon: item.icon,
        icon_size: settings.get_int('app-preview-icon-size') || 128,
        x_align: Clutter.ActorAlign.CENTER,
    }));
    wrapper.add_child(new St.Label({
        text: item.name, style_class: 'clone-title-overlay', x_align: Clutter.ActorAlign.CENTER,
    }));

    const appInfo = item.app.get_app_info?.();
    const description = appInfo?.get_description?.();
    if (description) {
        const desc = new St.Label({
            text: description, style_class: 'app-description-label', x_align: Clutter.ActorAlign.CENTER,
        });
        desc.clutter_text.set_line_wrap(true);
        desc.clutter_text.set_width(previewWidth - 80);
        wrapper.add_child(desc);
    }

    const pinButton = new St.Button({ style_class: 'app-preview-pin-button', can_focus: true });
    wrapper.add_child(pinButton);

    const actions = [];
    const raw = appInfo?.list_actions?.();
    if (raw?.length) {
        const box = new St.BoxLayout({ vertical: true, x_align: Clutter.ActorAlign.CENTER });
        for (const action of raw) {
            const button = new St.Button({
                style_class: 'app-preview-action-button',
                label: appInfo.get_action_name(action),
                can_focus: true,
            });
            box.add_child(button);
            actions.push({ button, action });
        }
        wrapper.add_child(box);
    }

    return { actor: wrapper, pinButton, actions };
}

// ==================== insertion math ====================
export function computeInsertion(rects, pointerX) {
    if (rects.length === 0) return { index: 0, neighbor: null, insertBefore: true };

    const first = rects[0];
    const last = rects[rects.length - 1];
    let target = last, before = false;

    if (pointerX < first.x) { target = first; before = true; }
    else if (pointerX < last.right) {
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i], next = rects[i + 1];
            if (pointerX >= r.x && pointerX < r.right) { target = r; before = pointerX < r.mid; break; }
            if (next && pointerX >= r.right && pointerX <= next.x) {
                before = (pointerX - r.right) > (next.x - pointerX);
                target = before ? next : r;
                break;
            }
        }
    }
    const i = rects.indexOf(target);
    return { index: before ? i : i + 1, neighbor: target.item, insertBefore: before };
}