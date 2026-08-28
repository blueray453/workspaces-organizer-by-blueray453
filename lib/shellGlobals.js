// Shared handles to GNOME Shell singletons and tunable constants used
// across the extension. Centralizing these means every module reads the
// same live objects instead of each re-deriving them.
export const screenWidth = global.get_screen_width();
export const screenHeight = global.get_screen_height();
export const WorkspaceManager = global.get_workspace_manager();
export const WindowTracker = global.get_window_tracker();
export const Display = global.get_display();

// Generic UI timing used by hover/cleanup timers.
export const TimeoutDelay = 200;

// Above this many windows on a workspace, the thumbnail switches from
// showing individual icons to a single "N windows" overflow button.
export const DIRECT_MODE_MAX_WINDOWS = 5;

export const SettleAnimationDuration = 300;