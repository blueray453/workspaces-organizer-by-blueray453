// ===== FILE: ./lib/sizes.js =====
// SINGLE SOURCE OF TRUTH for text/icon sizes.  px = round(BASE × ratio).
// UNIFORM: every text and icon ratio is 1.00 — all render at BASE px.
// Layout ratios (rowSlot, headH, pad, etc.) are sized so those uniform
// elements still fit comfortably.
// Groups in S keep their object identity, so `const F = S.flyout` at
// module top stays live after setBase().
import { createCssLoader } from './cssLoader.js';

export const BASE_DEFAULT = 96;

const RATIOS = {
    search: { text: 1.00, icon: 1.00, hint: 1.00 },
    indicator: {
        windowIcon: 1.00,
        toolbarIcon: 1.00,
        workspaceName: 1.00,
        empty: 1.00,
        closeButton: 1.00,
        closeOffsetX: 1.00,      // 40 — was 60
        closeOffsetY: 0.20,      //  8 — was 10
        previewHeight: 20,       // 800 — clone preview height, not a text/icon size
        denseFloor: 0.50,
    },
    badge: { min: 0.60, labelMin: 0.35 },
    tooltip: { text: 1.00 },
    flyout: {
        head: 1.00, rowIcon: 1.00, rowLabel: 1.00, rowSub: 1.00, rowBadge: 1.00,
        cancel: 1.00, edge: 1.00,
        rowSlot: 2.20,           // 88 — fits a 40px icon + breathing room
        headH: 1.20,             // 48
        edgeH: 1.00,             // 40
        cancelH: 1.25,           // 50
        cancelGap: 0.20,         //  8
        pad: 0.50,               // 20
        railW: 1.00,             // 40
        gap: 0.30,               // 12
    },
    selector: {
        center: 1.00, search: 1.00, tip: 1.00, bandIcon: 1.00, bandApp: 1.00,
        rowLabel: 1.00, rowIcon: 1.00,
        rowSlot: 2.00,           // 80
        bandH: 1.60,             // 64
        searchH: 1.60,           // 64
        railMarkerW: 0.60,       // 24
        railMarkerH: 0.15,       //  6
    },
    launcher: {
        heading: 1.00, tileLabel: 1.00, tileIcon: 1.00, pinnedIcon: 1.00,
        tileH: 3.00,             // 120 — 40px icon + 40px label + padding
        pinnedTile: 2.50,        // 100
        pinnedSectionH: 3.20,    // 128
        searchHeight: 2.00,      //  80
        resultsHeadingH: 1.20,   //  48
    },
    dmenu: {
        search: 1.00, searchIcon: 1.00, searchHint: 1.00, edgeLabel: 1.00,
        rowLabel: 1.00, rowIcon: 1.00, badge: 1.00, empty: 1.00,
        sectionLabel: 1.00, sectionCount: 1.00, controlName: 1.00,
        segment: 1.00, summary: 1.00, confirm: 1.00,
        rowHeight: 1.60,         // 64
        controlRowH: 1.40,       // 56
        controlHeadH: 0.90,      // 36
        footerH: 1.40,           // 56
        edgeH: 1.00,             // 40
        railW: 0.90,             // 36
        railGap: 0.25,           // 10
        stripGap: 0.25,          // 10
        searchHeight: 1.80,      // 72
    },
    dash: { icon: 1.00, menuItem: 1.00, tooltipGap: 0.50 },
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