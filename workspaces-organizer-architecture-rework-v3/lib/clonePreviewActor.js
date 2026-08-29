import Clutter from 'gi://Clutter';
import St from 'gi://St';

const LAYOUT = {
    TITLE_HEIGHT_MIN: 40,
    TITLE_HEIGHT_MAX: 100,
    TITLE_HEIGHT_FRACTION: 0.2,
};

// ==================== SHARED CLONE-PREVIEW BUILDER ====================
// Reuses the same clone/shadow math for both the icon hover-preview
// (WindowHoverPreview) and the search overlay preview (WindowSearchOverlay).
// Optionally wraps the clone in an outer, hover-tracking wrapper actor and
// optionally attaches a close button.
export function createClonePreviewActor(window, targetHeight, options = {}) {
    if (!window)
        return null;

    const windowActor = window.get_compositor_private();
    if (!windowActor)
        return null;

    const windowFrame = window.get_frame_rect();
    const bufferFrame = window.get_buffer_rect();
    if (windowFrame.height === 0)
        return null;

    const targetWidth = targetHeight * (windowFrame.width / windowFrame.height);
    const scale = targetHeight / windowFrame.height;
    const scaledLeftShadow = (windowFrame.x - bufferFrame.x) * scale;
    const scaledTopShadow = (windowFrame.y - bufferFrame.y) * scale;
    const scaledRightShadow = ((bufferFrame.x + bufferFrame.width) - (windowFrame.x + windowFrame.width)) * scale;
    const scaledBottomShadow = ((bufferFrame.y + bufferFrame.height) - (windowFrame.y + windowFrame.height)) * scale;

    const container = new St.BoxLayout({
        style_class: 'collection-preview-inner',
        width: targetWidth,
        height: targetHeight,
        clip_to_allocation: true,
    });

    const clone = new Clutter.Clone({
        source: windowActor,
        width: targetWidth + scaledLeftShadow + scaledRightShadow,
        height: targetHeight + scaledTopShadow + scaledBottomShadow,
    });
    clone.set_position(-scaledLeftShadow, -scaledTopShadow);

    const cloneContainer = new Clutter.Actor();
    cloneContainer.add_child(clone);
    container.add_child(cloneContainer);

    if (options.showTitle !== false) {
        const titleText = window.get_title();
        const label = titleText && titleText.trim() ? titleText : 'Untitled';
        const titleHeight = Math.min(
            LAYOUT.TITLE_HEIGHT_MAX,
            Math.max(LAYOUT.TITLE_HEIGHT_MIN, targetHeight * LAYOUT.TITLE_HEIGHT_FRACTION)
        );
        const title = new St.Label({
            style_class: 'clone-title-overlay',
            text: label,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        title.clutter_text.set_y_align(Clutter.ActorAlign.CENTER);
        title.clutter_text.set_line_wrap(true);
        title.set_size(targetWidth, titleHeight);
        title.set_position(0, (targetHeight - titleHeight) / 2);
        cloneContainer.add_child(title);
    }

    if (options.onClose) {
        const closeIconSize = options.closeButtonSize ?? 32;
        const closeOffsetX = options.closeButtonOffsetX ?? (closeIconSize + 14);
        const closeOffsetY = options.closeButtonOffsetY ?? 10;
        const closeButton = new St.Button({
            style_class: 'window-close-button',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: closeIconSize,
            }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            reactive: true,
        });
        closeButton.set_position(targetWidth - closeOffsetX, closeOffsetY);
        closeButton.connect('clicked', () => {
            options.onClose(window);
            return Clutter.EVENT_STOP;
        });
        cloneContainer.add_child(closeButton);
    }

    if (!options.wrapperStyleClass)
        return { actor: container, width: targetWidth, height: targetHeight };

    const wrapper = new St.BoxLayout({
        style_class: options.wrapperStyleClass,
        reactive: true,
        track_hover: true,
    });
    wrapper.add_child(container);

    if (options.onHoverChange) {
        wrapper.connect('notify::hover', () => {
            options.onHoverChange(wrapper.hover);
        });
    }

    if (options.onActivate) {
        wrapper.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                options.onActivate();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    return { actor: wrapper, inner: container, width: targetWidth, height: targetHeight };
}
