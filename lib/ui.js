import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
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

// ==================== clone preview (used by hover previews in interactions.js) ====================
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

// ==================== shared helpers (launcher + selector) ====================
function escapeMarkup(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pango markup with the characters at `indices` (a Set of UTF-16 offsets) bolded. */
export function highlightMarkup(text, indices) {
    if (!indices || indices.size === 0) return escapeMarkup(text);
    let out = '', open = false, i = 0;
    for (const ch of text) {
        const hit = indices.has(i);
        if (hit && !open) { out += '<b>'; open = true; }
        else if (!hit && open) { out += '</b>'; open = false; }
        out += escapeMarkup(ch);
        i += ch.length;
    }
    return open ? out + '</b>' : out;
}

const spacer = () => new St.Widget({ x_expand: true });

export function createFullscreenContainer(monitor, styleClass) {
    return new St.Widget({
        style_class: styleClass, reactive: true, can_focus: true, clip_to_allocation: true,
        x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
    });
}

export function createSearchField({ width, hint, keyHint = null, x = 0, y = 0 }) {
    const actor = new St.BoxLayout({ style_class: 'overlay-search', vertical: true, width, x, y });
    const entry = new St.Entry({
        style_class: 'overlay-search-entry', hint_text: hint, can_focus: true, x_expand: true,
        primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic', style_class: 'overlay-search-icon' }),
    });
    entry.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
    actor.add_child(entry);
    if (keyHint) {
        const hint = new St.Label({
            text: keyHint, style_class: 'overlay-search-hint',
            x_align: Clutter.ActorAlign.CENTER,
        });
        hint.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        hint.clutter_text.set_line_wrap(false);
        actor.add_child(hint);
    }
    return { actor, entry };
}

// ==================== app launcher ====================
export function computeLauncherLayout(monitor) {
    const margin = Math.max(24, Math.round(monitor.height * 0.04));
    const searchHeight = 160;
    const searchWidth = Math.min(1100, monitor.width - margin * 2);

    const searchY = margin;
    const pinnedY = searchY + searchHeight + 16;

    // Pinned section must fit: PINNED APPS heading + the tile row below it.
    // Heading at 110px needs ~150px of vertical space; pinned tiles are 200px.
    const pinnedHeight = 240;

    const resultsY = pinnedY + pinnedHeight + 16;

    // ALL APPS divider heading at 110px needs ~160px of vertical space.
    const resultsHeadingHeight = 70;

    const resultsHeight = Math.max(240, monitor.height - resultsY - margin);

    const fullWidth = monitor.width - margin * 2;
    const innerWidth = fullWidth - 40;
    const columns = Math.max(2, Math.min(8, Math.floor(innerWidth / 240)));
    const tileWidth = Math.floor(innerWidth / columns);

    return {
        margin, searchWidth,
        searchX: Math.round((monitor.width - searchWidth) / 2), searchY,
        fullWidth, fullX: margin,
        pinnedY, pinnedHeight,
        resultsY, resultsHeadingHeight, resultsHeight,
        columns, tileWidth, tileHeight: 340, iconSize: 144,
        pinnedTileWidth: 200, pinnedTileHeight: 200, pinnedIconSize: 160,
    };
}

export function createSectionHeading(text) {
    const label = new St.Label({
        text, style_class: 'launcher-heading',
        x_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
    label.clutter_text.set_line_wrap(false);
    return label;
}

/** ──── TEXT ──── heading with divider lines on both sides. */
export function createDividerHeading(text) {
    const actor = new St.BoxLayout({ style_class: 'launcher-divider-heading', x_expand: true });
    const line = () => new St.Widget({ style_class: 'launcher-divider', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
    const label = new St.Label({ text, style_class: 'launcher-heading', y_align: Clutter.ActorAlign.CENTER });
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
    label.clutter_text.set_line_wrap(false);
    actor.add_child(line());
    actor.add_child(label);
    actor.add_child(line());
    return { actor, label };
}

/** Pinned row: full-width, transparent, with left/right fade overlays that
 *  appear when there is off-screen content on that side. Uses EXTERNAL
 *  policy so no scrollbar is ever drawn. Children are laid out manually
 *  on every allocation change — BinLayout does not reliably honor
 *  `x_align` for edge-aligned overlay children on all Shell builds. */
export function createPinnedRow() {
    const wrap = new St.Widget({
        style_class: 'launcher-pinned-wrap',
        x_expand: true, y_expand: true,
    }); // default layout manager is Clutter.FixedLayout

    const scroll = new St.ScrollView({
        style_class: 'launcher-pinned-scroll',
        overlay_scrollbars: false,
    });
    scroll.set_policy(St.PolicyType.EXTERNAL, St.PolicyType.NEVER);
    const row = new St.BoxLayout({ style_class: 'launcher-pinned-row', x_expand: true });
    scroll.set_child(row);

    const FADE_W = 96;
    const leftFade = new St.Widget({
        style_class: 'launcher-pinned-fade-left',
        reactive: false, visible: false,
    });
    const rightFade = new St.Widget({
        style_class: 'launcher-pinned-fade-right',
        reactive: false, visible: false,
    });

    wrap.add_child(scroll);
    wrap.add_child(leftFade);
    wrap.add_child(rightFade);

    // FixedLayout honors set_position/set_size; recompute them on every
    // allocation so the scroll view fills the wrap and the fades sit flush
    // against the left and right edges.
    wrap.connect('notify::allocation', () => {
        const alloc = wrap.get_allocation_box();
        const w = alloc.x2 - alloc.x1;
        const h = alloc.y2 - alloc.y1;
        scroll.set_position(0, 0);
        scroll.set_size(w, h);
        leftFade.set_position(0, 0);
        leftFade.set_size(FADE_W, h);
        rightFade.set_position(w - FADE_W, 0);
        rightFade.set_size(FADE_W, h);
    });

    return { actor: wrap, scroll, box: row, leftFade, rightFade };
}

export function createGridScroll() {
    const scroll = new St.ScrollView({
        style_class: 'launcher-scroll', x_expand: true, y_expand: true, overlay_scrollbars: false,
    });
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    const box = new St.BoxLayout({ style_class: 'launcher-grid', vertical: true, x_expand: true });
    scroll.set_child(box);
    return { scroll, box };
}

/** One selectable tile: icon with its (wrapping) label underneath. Fixed size, so focus never shifts layout. */
export function createAppTile({ icon, name, indices = null, iconSize, width, height, showLabel = true }) {
    const button = new St.Button({
        style_class: 'launcher-tile', reactive: true, track_hover: true,
        accessible_name: name, width, height,
    });
    const box = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
    box.add_child(new St.Icon({
        gicon: icon ?? new Gio.ThemedIcon({ name: 'application-x-executable' }),
        icon_size: iconSize, x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    if (showLabel) {
        const label = new St.Label({ style_class: 'launcher-tile-label', x_align: Clutter.ActorAlign.CENTER });
        const text = label.clutter_text;
        text.set_line_wrap(true);
        text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        text.set_ellipsize(Pango.EllipsizeMode.END);
        text.set_line_alignment(Pango.Alignment.CENTER);
        text.set_markup(highlightMarkup(name, indices));
        label.set_width(width - 24);
        box.add_child(label);
    }
    button.set_child(box);
    return button;
}

// ==================== window selector ====================
export function computeSelectorLayout(monitor) {
    const rowHeight = Math.max(96, Math.round(monitor.height * 0.105));
    const selectedHeight = Math.round(rowHeight * 1.5);
    const searchHeight = 104;
    const bandHeight = selectedHeight + searchHeight + 40;
    return {
        monitorWidth: monitor.width, monitorHeight: monitor.height,
        rowHeight, selectedHeight, bandHeight,
        bandTop: Math.round((monitor.height - bandHeight) / 2),
        searchWidth: Math.min(monitor.width - 96, Math.round(monitor.width * 0.78)),
        iconSize: Math.round(rowHeight * 0.55),
        selectedIconSize: Math.round(selectedHeight * 0.6),
        fadeHeight: Math.round(monitor.height * 0.18),
    };
}

/** Full-width row: [spacer] icon + title [spacer]. Used for list rows and for the band's big row. */
export function createWindowTitleRow({ icon, title, indices = null, width, height, iconSize, selected = false }) {
    const row = new St.BoxLayout({
        style_class: selected ? 'selector-row selector-row-selected' : 'selector-row', width, height,
    });
    const inner = new St.BoxLayout({
        style_class: 'selector-row-inner', y_expand: true, y_align: Clutter.ActorAlign.CENTER,
    });
    inner.set_style(`max-width: ${Math.round(width * 0.85)}px;`);
    if (icon) {
        inner.add_child(new St.Icon({
            gicon: icon, icon_size: iconSize, style_class: 'selector-row-icon', y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    const label = new St.Label({
        style_class: selected ? 'selector-selected-label' : 'selector-row-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.START);
    label.clutter_text.set_markup(highlightMarkup(title, indices));
    inner.add_child(label);
    row.add_child(spacer());
    row.add_child(inner);
    row.add_child(spacer());
    return row;
}

export function createSelectionBand(layout) {
    const band = new St.BoxLayout({
        style_class: 'selector-band', vertical: true,
        x: 0, y: layout.bandTop, width: layout.monitorWidth, height: layout.bandHeight,
    });
    const titleBin = new St.Bin({ x_expand: true, height: layout.selectedHeight });
    band.add_child(titleBin);
    return { band, titleBin };
}

export function createFadeEdge(layout, top) {
    return new St.Widget({
        style_class: top ? 'selector-fade-top' : 'selector-fade-bottom', reactive: false,
        x: 0, y: top ? 0 : layout.monitorHeight - layout.fadeHeight,
        width: layout.monitorWidth, height: layout.fadeHeight,
    });
}

export function createSelectorHint(layout) {
    return new St.Label({
        text: 'Click to Activate • Esc to Close', style_class: 'selector-hint',
        x: 0, y: layout.monitorHeight - 56, width: layout.monitorWidth,
    });
}