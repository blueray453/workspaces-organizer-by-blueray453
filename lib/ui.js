// ===== FILE: ./lib/ui.js =====
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { S, REL } from './sizes.js';

// Re-export theme's hasher as colorForApp so existing callers keep working.
export { appColor as colorForApp } from './theme.js';

// ==================== focus / dim state ====================
// Single owner of the `focused` / `pick` classes and the opacity.
// `_dim` on the actor is:
//   false      — full opacity
//   true       — DIM_OPACITY (non-focused, no overlay active)
//   'filtered' — FILTERED_OPACITY (overlay is open, window doesn't match)
export const DIM_OPACITY = 150;
export const FILTERED_OPACITY = 60;

export function syncOpacity(actor) {
    const base = actor._dim === 'filtered' ? FILTERED_OPACITY
        : actor._dim ? DIM_OPACITY : 255;
    actor.opacity = (base < 255 && actor.hover) ? 255 : base;
}

export function setFocusState(actor, { focused = false, pick = false, dim = false }) {
    const toggle = (cls, on) => on
        ? actor.add_style_class_name(cls)
        : actor.remove_style_class_name(cls);
    toggle('focused', focused);
    toggle('pick', pick);
    actor._dim = dim;
    syncOpacity(actor);
}

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
    const actor = new St.Button({
        style_class: 'workspace-thumbnail',
        x_expand: false, y_expand: true,
        reactive: true, track_hover: true,
    });
    actor.set_style(`min-width: ${minWidth}px;`);
    if (active) actor.add_style_class_name('active');
    const box = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
    actor.set_child(box);
    return { actor, box };
}

export function createBadgedIcon({ gicon, size, count }) {
    const badgeSize = Math.max(S.badge.min, Math.round(size * REL.badgeOfIcon));
    const wrap = new St.Widget({
        style_class: 'ws-ico-wrap',
        width: size, height: size,
    });

    const icon = new St.Icon({ gicon, icon_size: size });
    wrap.add_child(icon);
    icon.set_position(0, 0);

    if (count > 1) {
        const label = new St.Label({
            style_class: 'ws-badge-label',
            text: String(count),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.set_style(`font-size: ${Math.max(S.badge.labelMin, Math.round(badgeSize * REL.badgeLabelOfBadge))}px;`);

        const badge = new St.Bin({
            style_class: 'ws-badge',
            width: badgeSize, height: badgeSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: label,
        });
        badge.set_style(`border-radius: ${Math.round(badgeSize / 2)}px;`);
        wrap.add_child(badge);
        badge.set_position(size - badgeSize, 0);
    }

    return { actor: wrap, icon };
}

export function createGroupButton({ gicon, count, size }) {
    const { actor: inner, icon } = createBadgedIcon({ gicon, size, count });
    const button = new St.Button({
        style_class: 'ws-app-group',
        reactive: true, track_hover: true, can_focus: true,
        child: inner,
    });
    return { actor: button, icon };
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

// ==================== flyout row ====================
export function createFlyoutRow({
    gicon, title, sub, badge = '',
    width, height, iconSize, labelSize,
}) {
    const row = new St.BoxLayout({
        style_class: 'ws-flyout-row',
        width, height,
        y_align: Clutter.ActorAlign.CENTER,
        reactive: true, track_hover: true,
    });

    row.add_child(new St.Icon({
        gicon, icon_size: iconSize,
        style_class: 'ws-flyout-row-icon',
        y_align: Clutter.ActorAlign.CENTER,
        style: `margin-right: ${S.flyout.iconGap}px;`,
    }));

    const text = new St.BoxLayout({
        vertical: true, x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const titleLabel = new St.Label({
        style_class: 'ws-flyout-row-title',
        x_expand: true, x_align: Clutter.ActorAlign.START,
        text: title,
    });
    titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.START);
    titleLabel.clutter_text.set_line_wrap(false);
    titleLabel.set_style(`font-size: ${labelSize}px;`);
    text.add_child(titleLabel);

    if (sub) {
        const subLabel = new St.Label({
            style_class: 'ws-flyout-row-app',
            x_expand: true, x_align: Clutter.ActorAlign.START,
            text: sub,
        });
        subLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        subLabel.clutter_text.set_line_wrap(false);
        subLabel.set_style(`font-size: ${S.flyout.rowSub}px;`);
        text.add_child(subLabel);
    }

    row.add_child(text);

    if (badge) {
        const badgeLabel = new St.Label({
            style_class: 'ws-flyout-row-badge',
            text: badge,
            y_align: Clutter.ActorAlign.CENTER,
        });
        badgeLabel.set_style(`font-size: ${S.flyout.rowBadge}px;`);
        row.add_child(badgeLabel);
    }

    return row;
}

// ==================== flyout cancel zone ====================
export function createCancelZone(text) {
    const label = new St.Label({
        style_class: 'ws-flyout-cancel-label', text,
        x_expand: true, y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
    label.clutter_text.set_line_wrap(false);
    const actor = new St.Bin({ style_class: 'ws-flyout-cancel', child: label });
    return { actor, label };
}

// ==================== flyout rail ====================
export function createRail() {
    const root = new St.Widget({ style_class: 'ws-flyout-rail', reactive: false });

    const TRACK_W = 4;
    const MARKER_W = 40;
    const MARKER_H = 12;

    const track = new St.Widget({ style_class: 'ws-flyout-rail-track' });
    root.add_child(track);

    const ticks = new St.Widget({ reactive: false });
    root.add_child(ticks);

    const marker = new St.Widget({
        style_class: 'ws-flyout-rail-marker',
        width: MARKER_W, height: MARKER_H,
    });
    root.add_child(marker);

    root.connect('notify::allocation', () => {
        const alloc = root.get_allocation_box();
        const w = Math.round(alloc.x2 - alloc.x1);
        const h = Math.round(alloc.y2 - alloc.y1);
        if (w <= 0 || h <= 0) return;
        track.set_position(Math.round((w - TRACK_W) / 2), 0);
        track.set_size(TRACK_W, h);
        marker.x = Math.round((w - MARKER_W) / 2);
    });

    return { root, track, ticks, marker };
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

// ==================== insertion math ====================
// rects: [{ item, start, end, mid, ... }] along the reorder axis.
export function computeInsertion(rects, p) {
    if (rects.length === 0) return { index: 0, neighbor: null, insertBefore: true };

    const first = rects[0];
    const last = rects[rects.length - 1];
    let target = last, before = false;

    if (p < first.start) { target = first; before = true; }
    else if (p < last.end) {
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i], next = rects[i + 1];
            if (p >= r.start && p < r.end) { target = r; before = p < r.mid; break; }
            if (next && p >= r.end && p <= next.start) {
                before = (p - r.end) > (next.start - p);
                target = before ? next : r;
                break;
            }
        }
    }
    const i = rects.indexOf(target);
    return { index: before ? i : i + 1, neighbor: target.item, insertBefore: before };
}

// ==================== text helpers ====================
function escapeMarkup(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

// ==================== container / field factories ====================
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

// ==================== app launcher primitives ====================
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

export function createPinnedRow() {
    const wrap = new St.Widget({
        style_class: 'launcher-pinned-wrap',
        x_expand: true, y_expand: true,
    });

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

// ==================== window selector primitives ====================
export function createWindowTitleRow({
    icon, title, indices = null,
    width, height, iconSize, labelSize,
    maxWidth = width * 0.60, selected = false,
}) {
    const row = new St.BoxLayout({
        style_class: selected ? 'selector-row selector-row-selected' : 'selector-row',
        width, height,
    });

    const inner = new St.BoxLayout({
        style_class: 'selector-row-inner', y_expand: true, y_align: Clutter.ActorAlign.CENTER,
    });

    const gap = Math.round((labelSize ?? 16) * 0.42);
    const labelMax = Math.max(80, Math.round(maxWidth) - (iconSize || 0) - gap);

    if (icon) {
        const iconActor = new St.Icon({
            gicon: icon, icon_size: iconSize,
            style_class: 'selector-row-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        iconActor.set_style(`margin-right: ${gap}px;`);
        inner.add_child(iconActor);
    }

    const label = new St.Label({
        style_class: selected ? 'selector-selected-label' : 'selector-row-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (labelSize != null) label.set_style(`font-size: ${labelSize}px;`);
    label.set_x_align(Clutter.ActorAlign.CENTER);
    label.set_width(labelMax);
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.START);
    label.clutter_text.set_markup(highlightMarkup(title, indices));
    inner.add_child(label);

    row.add_child(spacer());
    row.add_child(inner);
    row.add_child(spacer());
    return row;
}

export function createBandTitle({ icon, title, appName, width, height, iconSize, labelSize, appSize }) {
    const row = new St.BoxLayout({
        style_class: 'selector-band-title',
        width, height, x_align: Clutter.ActorAlign.CENTER,
    });

    const inner = new St.BoxLayout({
        style_class: 'selector-band-inner', y_align: Clutter.ActorAlign.CENTER,
    });

    if (icon) {
        inner.add_child(new St.Icon({
            gicon: icon, icon_size: iconSize,
            style_class: 'selector-band-icon', y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    const text = new St.BoxLayout({ vertical: true, style_class: 'selector-band-text' });

    const gap = 18;
    const textMax = Math.max(100, Math.round(width * 0.85) - (iconSize || 0) - gap);
    text.set_width(textMax);

    const titleLabel = new St.Label({
        style_class: 'selector-band-title-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    titleLabel.set_x_align(Clutter.ActorAlign.CENTER);
    titleLabel.set_width(textMax);
    titleLabel.set_style(`font-size: ${labelSize}px;`);
    titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.START);
    titleLabel.set_text(title);
    text.add_child(titleLabel);

    const appLabel = new St.Label({
        style_class: 'selector-band-app-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    appLabel.set_x_align(Clutter.ActorAlign.CENTER);
    appLabel.set_width(textMax);
    appLabel.set_style(`font-size: ${appSize}px;`);
    appLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.START);
    appLabel.set_text(appName || '');
    text.add_child(appLabel);

    inner.add_child(text);
    row.add_child(spacer());
    row.add_child(inner);
    row.add_child(spacer());
    return row;
}

export function createSelectionBand(bandL) {
    const band = new St.BoxLayout({
        style_class: 'selector-band', vertical: true,
        x: bandL.x, y: bandL.y, width: bandL.width, height: bandL.height,
    });
    const titleBin = new St.Bin({ x_expand: true, height: bandL.selectedHeight });
    band.add_child(titleBin);
    return { band, titleBin };
}