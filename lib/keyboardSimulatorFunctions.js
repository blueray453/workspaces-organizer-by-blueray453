// ===== FILE: ./lib/keyboardSimulatorFunctions.js =====
//
// Moved from gnome-utils. XML now lives in ./dbusService.js (the
// KeyboardSimulator interface). This file exports the three
// implementation functions plus init()/destroy() for the AT-SPI state
// and the polling timeout used by PressFromString.
//
// The three phantom methods from the original XML (EmitMetaO, Equal,
// Minus) were declared but never implemented; they are gone from the
// XML in dbusService.js too.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Atspi from 'gi://Atspi';

import { createLogger } from '../logger.js';
const journal = createLogger(import.meta.url);

const MODS = {
    SHIFT: Clutter.ModifierType.SHIFT_MASK,
    CTRL: Clutter.ModifierType.CONTROL_MASK,
    ALT: Clutter.ModifierType.MOD1_MASK,
    META: Clutter.ModifierType.MOD4_MASK,
};

const state = {
    timeoutId: 0,
    attempts: 0,
    atspiInited: false,
};

function typeString(text) {
    const chars = Array.from(text);
    journal(`[typeString] typing "${text}" (${chars.length} chars)`);

    for (const ch of chars) {
        const codepoint = ch.codePointAt(0);
        const keyval = Clutter.unicode_to_keysym(codepoint);
        journal(`[typeString] char='${ch}' codepoint=${codepoint} keyval=${keyval} (0x${keyval.toString(16)})`);

        if (keyval === 0) continue;
        pressKeys([keyval]);
    }
}

function pressKeys(keys) {
    const VirtualKeyboard = Clutter.get_default_backend()
        .get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

    const eventTime = Clutter.get_current_event_time() * 1000;

    for (const key of keys)
        VirtualKeyboard.notify_keyval(eventTime, key, Clutter.KeyState.PRESSED);

    for (let i = keys.length - 1; i >= 0; i--)
        VirtualKeyboard.notify_keyval(eventTime, keys[i], Clutter.KeyState.RELEASED);
}

function keyNameToClutterKey(keyName) {
    const name = keyName.trim();
    const keyConstant = `KEY_${name}`;
    if (Clutter[keyConstant] === undefined)
        throw new Error(`Invalid key name: ${name}`);
    return Clutter[keyConstant];
}

function keysReleased(onReleased) {
    state.attempts = 0;
    const MAX_ATTEMPTS = 40;

    state.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
        const [, , modifiers] = global.get_pointer();
        state.attempts++;

        const relevant = modifiers & (MODS.SHIFT | MODS.CTRL | MODS.ALT | MODS.META);

        if (relevant === 0) {
            onReleased();
            journal(`[Attempt ${state.attempts}] All relevant modifiers released!`);
            state.timeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }

        if (state.attempts >= MAX_ATTEMPTS) {
            onReleased();
            journal('Max attempts reached, stopping logger.');
            state.timeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }

        return GLib.SOURCE_CONTINUE;
    });
}

export function PressFromString(input) {
    const keys = input.split(',').map(k => keyNameToClutterKey(k));
    keysReleased(() => pressKeys(keys));
}

export function SelectAllFsearchText() {
    const ATSPI_APP_NAME = 'io.github.cboxdoerfer.FSearch';
    const KNOWN_PREFIXES = ['book-c ', 'notesfiltered '];

    if (!state.atspiInited) {
        Atspi.init();
        state.atspiInited = true;
    }

    const desktop = Atspi.get_desktop(0);
    const appCount = desktop.get_child_count();

    let app = null;
    for (let i = 0; i < appCount; i++) {
        const candidate = desktop.get_child_at_index(i);
        if (candidate && candidate.get_name() === ATSPI_APP_NAME) {
            app = candidate;
            break;
        }
    }

    if (!app) {
        journal('[SelectAllFsearchText] fsearch app not found');
        return;
    }

    let entry;
    try {
        entry = app
            .get_child_at_index(0)  // frame
            .get_child_at_index(0)  // filler
            .get_child_at_index(0)  // filler
            .get_child_at_index(0)  // filler
            .get_child_at_index(0); // text
    } catch (e) {
        journal(`[SelectAllFsearchText] fixed path failed: ${e}`);
        return;
    }

    if (!entry.is_text()) {
        journal('[SelectAllFsearchText] entry is not text');
        return;
    }

    entry.grab_focus();

    const textIface = entry.get_text_iface();

    const fullText = Atspi.Text.prototype.get_text.call(textIface, 0, -1);
    journal(`[SelectAllFsearchText] fullText: "${fullText}"`);

    let startOffset = 0;
    const matchedPrefix = KNOWN_PREFIXES.find(prefix => fullText.startsWith(prefix));
    if (matchedPrefix)
        startOffset = matchedPrefix.length;

    textIface.set_caret_offset(startOffset);
    textIface.add_selection(startOffset, -1);
}

export function TestTypeString() {
    typeString('This is a test');
}

// ---- lifecycle ----

export function init() {
    state.timeoutId = 0;
    state.attempts = 0;
    state.atspiInited = false;
}

export function destroy() {
    journal(`Destroy is called`);
    if (state.timeoutId) {
        GLib.source_remove(state.timeoutId);
        state.timeoutId = 0;
    }
}