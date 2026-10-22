// ===== FILE: ./lib/sizes.js =====
// SINGLE SOURCE OF TRUTH for text/icon sizes.  px = round(BASE × ratio).
// Groups in S keep their object identity, so `const F = S.flyout` at
// module top stays live after setBase().
import { createCssLoader } from './cssLoader.js';

export const BASE_DEFAULT = 40;

const RATIOS = {
    search: { text: 1.00, icon: 1.05, hint: 0.95 },
    indicator: {
        windowIcon: 2.40,      // 96  (was 'icon-size')
        toolbarIcon: 1.40,     // 56  (was 'toolbar-icon-size')
        workspaceName: 1.00,   // 40  (was 'workspace-name-font-size')
        empty: 0.275,          // 11
        closeButton: 0.80,     // 32  (was 'close-button-size')
        closeOffsetX: 1.50,    // 60
        closeOffsetY: 0.25,    // 10
        previewHeight: 20,     // 800 (was 'hover-preview-height')
        denseFloor: 0.50,      // 20
    },
    badge: { min: 0.60, labelMin: 0.35 },
    tooltip: { text: 0.475 },  // 19  (was 14pt ≈ 18.67px)
    flyout: {
        head: 1.00, rowIcon: 2.40, rowLabel: 1.30, rowSub: 0.935, rowBadge: 0.80,
        cancel: 0.90, edge: 0.80,
        rowSlot: 3.60, headH: 1.80, edgeH: 1.50, cancelH: 2.00, cancelGap: 0.30,
        pad: 0.70, railW: 1.40, gap: 0.40,
    },
    selector: {
        center: 1.80, search: 1.00, tip: 0.80, bandIcon: 2.80, bandApp: 0.55,
        rowLabel: 1.58, rowIcon: 1.82, rowSlot: 2.45, bandH: 3.50, searchH: 2.60,
        railMarkerW: 0.80, railMarkerH: 0.20,
    },
    launcher: {
        heading: 0.95, tileLabel: 1.30, tileIcon: 3.60, pinnedIcon: 4.00,
        tileH: 8.50, pinnedTile: 5.00,
        pinnedSectionH: 6.00, searchHeight: 4.00, resultsHeadingH: 1.75,
    },
    dmenu: {
        search: 1.10, searchIcon: 0.90, searchHint: 0.90, edgeLabel: 0.90,
        rowLabel: 1.20, rowIcon: 1.80, rowHeight: 2.80, badge: 0.85, empty: 1.00,
        sectionLabel: 0.75, sectionCount: 0.75, controlName: 0.90, segment: 0.80,
        summary: 0.80, confirm: 0.80,
        controlRowH: 2.10, controlHeadH: 1.20, footerH: 2.10, edgeH: 1.20,
        railW: 1.20, railGap: 0.30, stripGap: 0.30, searchHeight: 3.00,
    },
    dash: { icon: 3.20, menuItem: 0.80, tooltipGap: 0.55 },
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
