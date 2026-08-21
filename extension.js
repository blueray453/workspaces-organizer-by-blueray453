import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { setLogging, setLogFn, journal } from './utils.js';
import { WorkspaceIndicator } from './lib/workspaceIndicator.js';
import { TitleBarMoveMonitor } from './lib/titleBarMoveMonitor.js';

export default class TopNotchWorkspaces extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._titleBarMoveMonitor = null;
    }

    enable() {
        setLogFn((msg, error = false) => {
            const level = error ? GLib.LogLevelFlags.LEVEL_CRITICAL : GLib.LogLevelFlags.LEVEL_MESSAGE;
            GLib.log_structured(
                'workspaces-organizer-by-blueray453',
                level,
                {
                    MESSAGE: `${msg}`,
                    SYSLOG_IDENTIFIER: 'workspaces-organizer-by-blueray453',
                    CODE_FILE: GLib.filename_from_uri(import.meta.url)[0],
                }
            );
        });
        setLogging(true);
        journal(`Enabled`);

        const settings = this.getSettings(); // Reads settings-schema from metadata.json

        this._indicator = new WorkspaceIndicator(settings);
        Main.panel.addToStatusArea('workspace-indicator', this._indicator, 0, 'left');

        this._titleBarMoveMonitor = new TitleBarMoveMonitor();
    }

    disable() {
        if (this._titleBarMoveMonitor) {
            this._titleBarMoveMonitor.destroy();
            this._titleBarMoveMonitor = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}