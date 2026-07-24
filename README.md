# Workspaces Organizer

A powerful GNOME Shell extension that provides a horizontal workspace indicator with visual app previews, drag-and-drop window organization, and intuitive workspace switching. This extension enhances GNOME's workspace management with modern UI and advanced interaction patterns.

**Fork of**: [Workspace Indicator by fmuellner](https://github.com/fmuellner/gnome-shell-extensions) with significant enhancements.

## Features

### 🎯 Workspace Indicator
- **Horizontal workspace display** in the top panel showing all available workspaces
- **Active workspace highlighting** with visual indicator
- **Workspace name display** alongside the indicator
- **Scroll to switch** workspaces by scrolling over the indicator
- **Left-click activation** to switch to any workspace instantly

### 🪟 Window Management
- **App icons display** for all open windows in each workspace
- **Visual app previews** on hover showing live window content
- **Drag-and-drop** to move windows between workspaces
- **Context menu** with window-specific actions (activate, close, close all, etc.)
- **Window grouping** - manage multiple windows of the same application
- **Smart icon sizing** that automatically scales based on window count

### 🖱️ Interactive Previews
- **Live window preview** on hover showing the actual window content
- **CTRL+Hover** displays window title instead of full preview
- **Close button** directly on preview for quick window closure
- **Click to focus** - click preview to bring window to focus
- **Smooth animations** with fade-in/out effects
- **Smart positioning** to keep previews visible on screen

### ⚙️ Customization
- **Editable styling** via `stylesheet.css`
- **Customizable colors** for active/inactive workspaces
- **Adjustable sizes** for workspace boxes and icons
- **Border and highlight** customization
- **Works with** Dash to Panel and other panel extensions

## Installation

### From GNOME Extensions
Install directly from the official GNOME Extensions website:
[Workspaces Organizer on extensions.gnome.org](https://extensions.gnome.org/extension/8751/workspaces-organizer/)

### Manual Installation

1. Clone the repository:
```bash
git clone https://github.com/blueray453/workspaces-organizer-by-blueray453.git \
  ~/.local/share/gnome-shell/extensions/workspaces-organizer-by-blueray453@github.com
```

2. Restart GNOME Shell:
```bash
Alt + F2
Type: r
Press: Enter
```

3. Enable the extension:
```bash
gnome-extensions enable workspaces-organizer-by-blueray453
```

Or enable it through GNOME Settings → Extensions.

## Compatibility

- **GNOME Shell**: 46, 47, 48
- **Display Server**: Works with both X11 and Wayland
- **License**: GNU General Public License v2.0

## Usage

### Basic Operations

- **Switch workspaces**: Click on any workspace in the indicator
- **Scroll to switch**: Scroll your mouse wheel over the indicator
- **Move windows**: Drag a window icon to another workspace
- **Preview window**: Hover over any app icon to see the live preview
- **Close window**: Click the close button (×) on the preview or right-click for context menu
- **Focus window**: Click on the preview to bring it to focus

### Context Menu Actions

Right-click on a window icon to access:
- **Activate** - Switch to and focus the window
- **Close** - Close the specific window
- **Close Except** - Close all other windows of the same application
- **Application Actions** - App-specific actions (if available)

Right-click on a workspace to access:
- **Close all windows on all workspaces**
- **Close all windows except this workspace**
- **Close all windows on this workspace**

## Customization

### Styling

Edit `stylesheet.css` to customize appearance:

```css
/* Change workspace box size */
.panel-workspace-indicator-box .workspace {
    width: 70px;
    height: 28px;
}

/* Active workspace highlight color */
.panel-workspace-indicator-box .workspace.active {
    background-color: rgba(44, 183, 60, 0.362);
}

/* Workspace border */
.panel-workspace-indicator-box .workspace {
    border: 2px solid #10421d;
}

/* Preview styling */
.hover-preview-wrapper {
    background-color: rgba(0, 0, 0, 0.95);
    border-radius: 8px;
}
```

### Available CSS Classes

- `.workspace-indicator-main-box` - Main container
- `.workspace-name-label` - Workspace name display
- `.workspace-indicator-class` - Thumbnails container
- `.workspace-thumbnail` - Individual workspace box
- `.workspace-thumbnail.active` - Active workspace
- `.hover-preview-wrapper` - Live preview container
- `.hover-preview-inner` - Preview inner container
- `.hover-title-popup` - Title label on CTRL+hover

## Architecture

### Core Components

1. **WorkspaceIndicator** - Main extension class
   - Manages the top panel widget
   - Handles workspace switching and navigation
   - Coordinates with workspace manager

2. **WorkspaceThumbnail** - Individual workspace representation
   - Displays all windows in a workspace
   - Handles drag-and-drop operations
   - Manages context menus

3. **WindowPreview** - Individual window representation
   - Renders app icon
   - Manages hover preview display
   - Handles window interactions and dragging
   - Polls CTRL key state for preview mode switching

4. **PreviewRegistry** - Singleton preview manager
   - Manages active window preview
   - Polls CTRL key state with minimal overhead
   - Ensures only one preview is active at a time

### Key Features

- **Preview Registry**: Centralized management of hover previews with CTRL key polling
- **Memory Efficient**: Timers and signals are properly cleaned up
- **Smooth Animations**: Fade-in/out effects with Clutter animations
- **Responsive**: Dynamic icon sizing based on window count
- **DND Support**: Full drag-and-drop support for window moving

## Development

### Requirements

- GNOME Shell 46+
- GJS (GNOME JavaScript)
- JavaScript module support (ES6 imports)

### Building and Testing

1. Make changes to the extension files
2. Restart GNOME Shell:
   ```bash
   Alt + F2
   r
   Enter
   ```
3. Or disable/enable the extension:
   ```bash
   gnome-extensions disable workspaces-organizer-by-blueray453
   gnome-extensions enable workspaces-organizer-by-blueray453
   ```

### Debugging

View extension logs:
```bash
journalctl -f -o cat SYSLOG_IDENTIFIER=workspaces-organizer-by-blueray453
```

## File Structure

```
workspaces-organizer-by-blueray453/
├── extension.js           # Main extension code with all components
├── metadata.json          # Extension metadata
├── stylesheet.css         # Theme and styling
├── utils.js              # Utility functions and logging
├── signals.adoc           # D-Bus signal documentation
├── README.md             # This file
└── LICENSE.txt           # GPL v2 license
```

## Configuration

The extension reads from standard GNOME preferences. To modify defaults, edit the source code:

- **Icon size**: Adjust in `WindowPreview` constructor (line 156)
- **Preview height**: Modify `previewHeight` variable in `_showHoverPreview` (line 330)
- **Timeout delay**: Change `TimeoutDelay` constant (line 26)
- **Preview position**: Adjust position calculations in `_showHoverPreview`

## Known Limitations

- Preview is hidden when switching workspaces
- Window previews are hidden when the Activities overview opens
- Title preview (CTRL+Hover) may affect some keybindings

## Contributing

Contributions are welcome! Areas for enhancement:
- Performance optimizations
- Additional preview customization options
- Multi-monitor improvements
- Additional window management features

## Support

For issues and feature requests:
- GitHub Issues: [Report an issue](https://github.com/blueray453/workspaces-organizer-by-blueray453/issues)
- GNOME Extensions: [Leave a review/feedback](https://extensions.gnome.org/extension/8751/workspaces-organizer/)

## Credits

- **Original**: Workspace Indicator by fmuellner
- **Fork & Enhancement**: blueray453
- **Icon Design**: GNOME Project

## License

GNU General Public License v2.0 or later. See [LICENSE.txt](LICENSE.txt) for details.

## Donations

If you find this extension useful and want to support development:
- **PayPal**: MarkoMiskovic

## Changelog

### Version 5 (Current)
- Enhanced live preview system
- Added CTRL key polling for preview mode switching
- Improved memory management and cleanup
- Better window grouping and organization
- Customizable styling and appearance
- Context menu improvements
- Dynamic icon sizing based on window count

### Previous Versions
- Built on Workspace Indicator foundation
- Enhancements for modern GNOME Shell versions

## See Also

- [GNOME Extensions](https://extensions.gnome.org)
- [GNOME Shell Source](https://gitlab.gnome.org/GNOME/gnome-shell)
- [GJS Documentation](https://gjs.guide/)
