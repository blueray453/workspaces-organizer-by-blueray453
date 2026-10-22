// ===== FILE: ./lib/sizes.js =====
// SINGLE SOURCE OF TRUTH for text/icon sizes.  px = round(BASE × ratio).
//
// ICONS: every content icon renders at 96px — the original `icon-size`
// default from the schema. This ratio (2.40) is applied to the panel
// window icon, flyout row icon, dmenu row icon, launcher tile / pinned
// icon, selector band / row icon, and dash icon, so every icon you see
// that represents a window or app is the same size.
//
// TEXT: 40px uniform (ratio 1.00) — matches the original
// `workspace-name-font-size` default.
//
// UI CHROME icons (search magnifier, toolbar button, close X) are
// NOT content icons and stay at their original smaller sizes.
//
// Layout ratios are sized so 96px icons + 40px text fit comfortably.
import { createCssLoader } from './cssLoader.js';

export const BASE_DEFAULT = 40;

const RATIOS = {
    // Magnifier in the search field — UI chrome, not a content icon
    search: { text: 1.00, icon: 1.00, hint: 1.00 },

    indicator: {
        windowIcon: 2.40,       //  96 — panel window / drag icon (was icon-size=96)
        toolbarIcon: 1.40,      //  56 — toolbar button (was toolbar-icon-size=56, UI chrome)
        workspaceName: 1.00,    //  40 — text
        empty: 1.00,            //  40 — text
        closeButton: 0.80,      //  32 — close X (was close-button-size=32, UI chrome)
        closeOffsetX: 1.50,     //  60 — positioning
        closeOffsetY: 0.25,     //  10 — positioning
        previewHeight: 20,      // 800 — clone preview height
        denseFloor: 0.50,       //  20 — minimum icon when crowded
    },

    badge: { min: 0.60, labelMin: 0.35 },

    tooltip: { text: 1.00 },    //  40 — text

    flyout: {
        head: 1.00,             //  40 — text
        rowIcon: 2.40,          //  96 — icon (was ROW_ICON_SIZE=96)
        rowLabel: 1.00,         //  40 — text
        rowSub: 1.00,           //  40 — text
        rowBadge: 1.00,         //  40 — text
        cancel: 1.00,           //  40 — text
        edge: 1.00,             //  40 — text
        rowSlot: 3.60,          // 144 — fits 96 icon (matches original)
        headH: 1.80,            //  72 — header strip
        edgeH: 1.50,            //  60 — edge hold zones
        cancelH: 2.00,          //  80 — cancel drop zone
        cancelGap: 0.30,        //  12
        pad: 0.70,              //  28
        railW: 1.40,            //  56
        gap: 0.40,              //  16
    },

    selector: {
        center: 1.80,           //  72 — band title (large by design)
        search: 1.00,           //  40 — search field text
        tip: 1.00,              //  40 — rail tooltip
        bandIcon: 2.40,         //  96 — band icon
        bandApp: 1.00,          //  40 — app-name line
        rowLabel: 1.00,         //  40 — neighbor row text
        rowIcon: 2.40,          //  96 — neighbor row icon
        rowSlot: 3.40,          // 136 — row fits 96 icon
        bandH: 3.50,            // 140 — band height fits 96 icon + 72 title
        searchH: 2.60,          // 104 — search field height
        railMarkerW: 0.80,      //  32
        railMarkerH: 0.20,      //   8
    },

    launcher: {
        heading: 1.00,          //  40 — heading text
        tileLabel: 1.00,        //  40 — tile label
        tileIcon: 2.40,         //  96 — tile icon (was 144)
        pinnedIcon: 2.40,       //  96 — pinned icon (was 160)
        tileH: 5.00,            // 200 — tile fits 96 icon + 40 label
        pinnedTile: 3.50,       // 140 — pinned tile (icon + padding)
        pinnedSectionH: 5.10,   // 204 — pinned section
        searchHeight: 3.50,     // 140 — search field height
        resultsHeadingH: 1.75,  //  70 — heading strip
    },

    dmenu: {
        search: 1.00,           //  40
        searchIcon: 1.00,       //  40 — magnifier (UI chrome)
        searchHint: 1.00,       //  40
        edgeLabel: 1.00,        //  40
        rowLabel: 1.00,         //  40
        rowIcon: 2.40,          //  96 — icon (was 72)
        rowHeight: 3.40,        // 136 — row fits 96 icon
        badge: 1.00,            //  40
        empty: 1.00,            //  40
        sectionLabel: 1.00,     //  40
        sectionCount: 1.00,     //  40
        controlName: 1.00,      //  40
        segment: 1.00,          //  40
        summary: 1.00,          //  40
        confirm: 1.00,          //  40
        controlRowH: 2.10,      //  84
        controlHeadH: 1.20,     //  48
        footerH: 2.10,          //  84
        edgeH: 1.20,            //  48
        railW: 1.20,            //  48
        railGap: 0.30,          //  12
        stripGap: 0.30,         //  12
        searchHeight: 3.00,     // 120
    },

    dash: {
        icon: 2.40,             //  96 — icon (was 128)
        menuItem: 1.00,         //  40 — menu text
        tooltipGap: 0.55,       //  22
    },
};

export const REL = {
    badgeOfIcon: 0.60,
    badgeLabelOfBadge: 0.56,
    denseLadder: [1, 0.9, 0.78, 0.66, 0.55],
};

export const S = {};
let _base = BASE_DEFAULT;
const _listeners = new Set();

export const base = () => _base;
export const px = r => Math.max(1, Math.round(_base * r));

function _resolve() {
    for (const [g, entries] of Object.entries(RATIOS)) {
        S[g] ??= {};
        for (const [k, r] of Object.entries(entries)) S[g][k] = px(r);
    }
}
_resolve();

const f = v => `font-size: ${v}px;`;
const i = v => `icon-size: ${v}px;`;

function buildCss() {
    return `
.ws-empty { ${f(S.indicator.empty)} }
.topnotch-tooltip { ${f(S.tooltip.text)} }
.overlay-search-entry { ${f(S.search.text)} }
.overlay-search-icon { ${i(S.search.icon)} }
.overlay-search-hint { ${f(S.search.hint)} }
.ws-flyout-head { ${f(S.flyout.head)} }
.ws-flyout-row-app { ${f(S.flyout.rowSub)} }
.ws-flyout-row-badge { ${f(S.flyout.rowBadge)} }
.ws-flyout-cancel-label { ${f(S.flyout.cancel)} }
.ws-flyout-edge-label { ${f(S.flyout.edge)} }
.launcher-heading { ${f(S.launcher.heading)} }
.launcher-tile-label { ${f(S.launcher.tileLabel)} }
.dmenu-panel .overlay-search-entry { ${f(S.dmenu.search)} }
.dmenu-panel .overlay-search-icon { ${i(S.dmenu.searchIcon)} }
.dmenu-panel .overlay-search-hint { ${f(S.dmenu.searchHint)} }
.dmenu-panel .ws-flyout-edge-label { ${f(S.dmenu.edgeLabel)} }
.dmenu-result-label { ${f(S.dmenu.rowLabel)} }
.dmenu-badge { ${f(S.dmenu.badge)} }
.dmenu-empty { ${f(S.dmenu.empty)} }
.dmenu-section-label { ${f(S.dmenu.sectionLabel)} }
.dmenu-section-count { ${f(S.dmenu.sectionCount)} }
.dmenu-control-name { ${f(S.dmenu.controlName)} }
.dmenu-segment { ${f(S.dmenu.segment)} }
.dmenu-summary { ${f(S.dmenu.summary)} }
.dmenu-confirm { ${f(S.dmenu.confirm)} }
.pinned-edge-menu .popup-menu-item { ${f(S.dash.menuItem)} }
`;
}

const _css = createCssLoader('topnotch-sizes', buildCss);
let _settings = null, _sid = 0;

export function setBase(v) {
    v = Math.max(8, Math.round(v));
    if (v === _base) return;
    _base = v; _resolve(); _css.apply();
    for (const cb of [..._listeners]) {
        try { cb(); } catch (e) { console.error(`[sizes] listener: ${e.message}`); }
    }
}
export function onSizesChanged(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }

export function initSizes(settings = null) {
    _settings = settings;
    const has = settings?.settings_schema?.has_key('base-size');
    _base = has ? settings.get_int('base-size') : BASE_DEFAULT;
    _resolve(); _css.apply();
    if (has) _sid = settings.connect('changed::base-size',
        () => setBase(settings.get_int('base-size')));
}
export function destroySizes() {
    if (_settings && _sid) _settings.disconnect(_sid);
    _settings = null; _sid = 0; _listeners.clear(); _css.destroy();
}