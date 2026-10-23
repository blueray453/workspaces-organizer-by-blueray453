// ===== FILE: ./lib/theme.js =====
// SINGLE SOURCE OF TRUTH for color, transparency, radius, border, shadow.
// (Motion lives in motion.js; sizes live in sizes.js.)
import { createCssLoader } from './cssLoader.js';
import { px } from './sizes.js';

export const GLASS_DEFAULT = 1.0;

export const PALETTE = {
    base03: '#002b36', base02: '#073642', base01: '#586e75', base00: '#657b83',
    base0: '#839496', base1: '#93a1a1', base2: '#eee8d5', base3: '#fdf6e3',
    yellow: '#b58900', orange: '#cb4b16', red: '#dc322f', magenta: '#d33682',
    violet: '#6c71c4', blue: '#268bd2', cyan: '#2aa198', green: '#859900',
    ink0: '#00121a', ink1: '#001a22', ink2: '#00161e',
    cyanBright: '#4fd1c5',
    paper: '#fffaf0',
    paperDim: '#f1ede0',
    badgeBg: '#101820',
    black: '#000000',
    pureWhite: '#ffffff',
    tealDeep: '#01252e', tealRow: '#07323c', tealRowEdge: '#12434d',
    tealSel: '#0d4651', tealSelEdge: '#17606b',
    tealBadge: '#9dc8c7', tealBadgeEdge: '#2d6871',
    tealSeg: '#15515a', tealSegEdge: '#267681',
    tealBtn: '#176f68', tealBtnEdge: '#2f9990', tealBtnHover: '#21877e',
};

export const ROLES = {
    bgDeep: 'base03', bgRaised: 'base02',
    bgInk: 'ink1', bgInkDeep: 'ink0', shadow: 'ink2',
    text: 'base2', textStrong: 'base3', textBright: 'paper', textSoft: 'paperDim',
    textMuted: 'base1', textDim: 'base00', textFaint: 'base01',
    textOnAccent: 'base03',
    accent: 'cyan', accentBright: 'cyanBright',
    info: 'blue', danger: 'red', warn: 'orange', ok: 'green',
    edge: 'base01',
};

export const APP_COLORS = ['blue', 'orange', 'green', 'magenta', 'cyan', 'yellow', 'violet', 'red'];

const TIERS = {
    solid: 0.97, firm: 0.72, glass: 0.58, tint: 0.32, hover: 0.20, wash: 0.15, clear: 0.00,
};
const SCALABLE = new Set(['firm', 'glass', 'tint', 'hover', 'wash']);

export const SURFACES = {
    tooltip: ['bgRaised', 'solid'],
    searchEntry: ['bgDeep', 'solid'],
    thumb: ['bgRaised', 'firm'],
    thumbHover: ['bgRaised', 'solid'],
    thumbActive: ['textMuted', 'tint'],
    thumbDrop: ['info', 'tint'],
    groupHover: ['info', 'hover'],
    toolbarHover: ['info', 'hover'],
    flyout: ['bgDeep', 'glass'],
    flyoutRow: ['bgRaised', 'firm'],
    flyoutRowSel: ['info', 'tint'],
    flyoutRowBadge: ['accent', 'hover'],
    cancelZone: ['warn', 'hover'],
    cancelZoneActive: ['danger', 'tint'],
    selectorTint: ['bgInk', 'wash'],
    selectorTintCancel: ['danger', 'hover'],
    selectorList: ['bgDeep', 'glass'],
    selectorBand: ['bgDeep', 'clear'],
    selectorRow: ['bgDeep', 'clear'],
    selectorRail: ['bgInkDeep', 'firm'],
    selectorTip: ['bgInkDeep', 'solid'],
    launcher: ['bgDeep', 'solid'],
    launcherTileHover: ['textMuted', 'hover'],
    launcherTileFocus: ['accent', 'tint'],
    dmenuOverlay: ['bgInk', 'wash'],
    dmenuPanel: ['bgDeep', 'solid'],
    dmenuRow: ['bgRaised', 'firm'],
    dmenuRowHover: ['bgRaised', 'solid'],
    dmenuRowSel: ['info', 'tint'],
    dash: ['bgDeep', 'solid'],
    dashItemHover: ['accent', 'hover'],
    menu: ['bgRaised', 'solid'],
    menuItemHover: ['accent', 'tint'],
    dragPlaceholder: ['info', 'hover'],
    cloneTitle: ['bgInkDeep', 'firm'],
};

export const TEXT = {
    flyoutHead: 'accent', flyoutRowTitle: 'text', flyoutRowApp: 'text',
    flyoutBadge: 'accent', flyoutEdge: 'textFaint', flyoutEdgeActive: 'text',
    cancelLabel: 'text', tooltip: 'text',
    searchEntry: 'text', searchIcon: 'textMuted', searchHint: 'textDim',
    launcherHeading: 'textDim', launcherTile: 'text',
    selectorTitle: 'textStrong', selectorApp: 'accentBright', selectorRow: 'textStrong',
    selectorEntry: 'textStrong',
    dmenuRow: 'text', dmenuRowSel: 'textStrong', dmenuEmpty: 'textDim',
    dmenuSection: 'textFaint', dmenuControl: 'text',
    dmenuSegment: 'base0', dmenuSegmentOn: 'textStrong',
    menuItem: 'text', menuItemDisabled: 'textFaint',
    workspaceName: 'text',
    badgeLabel: 'pureWhite',
};

export const LINES = {
    thumb: ['edge', 0.60],
    thumbRing: ['edge', 0.45],
    thumbActive: ['textMuted', 0.9],
    focusPill: ['accent', 1],
    flyout: ['edge', 0.55], flyoutRowSel: ['info', 1],
    focusBorder: ['accent', 1], selectBorder: ['ok', 1], focusRing: ['accent', 1],
    searchEntry: ['edge', 1], searchFocus: ['accent', 1],
    divider: ['edge', 0.85], dash: ['edge', 0.55], menu: ['accent', 0.75],
    dragSource: ['info', 1], dragGhost: ['info', 1],
    cancelZone: ['warn', 0.85],
    selectorEdge: ['textMuted', 0.55],
    selectorEdgeSoft: ['textMuted', 0.40],
    selectorListEdge: ['textMuted', 0.55],
};

const RADIUS_RATIO = { xs: 0.15, sm: 0.20, md: 0.30, lg: 0.50, xl: 0.70 };
export const BORDER = { hair: 1, thin: 2, thick: 3, frame: 4 };

export const SHADOW = {
    glow: [0, 56, 22, 'bgDeep', 0.48],
    drop: [12, 36, 10, 'shadow', 0.78],
    panel: [0, 48, 20, 'shadow', 0.55],
    edge: [0, 40, 10, 'shadow', 0.65],
    band: [0, 90, 48, 'shadow', 0.34],
};

let _glass = GLASS_DEFAULT;
const _hex = nameOrHex => PALETTE[nameOrHex] ?? PALETTE[ROLES[nameOrHex]] ?? nameOrHex;
const _clamp01 = v => Math.max(0, Math.min(1, v));

export function rgba(color, a = 1) {
    const h = _hex(color).replace('#', '');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(a * 1000) / 1000})`;
}
export function alpha(tier) {
    const a = TIERS[tier] ?? 1;
    return SCALABLE.has(tier) ? _clamp01(a * _glass) : a;
}
export const color = nameOrHex => _hex(nameOrHex);
export const surface = name => {
    const [role, tier] = SURFACES[name];
    return rgba(role, alpha(tier));
};
export const line = name => {
    const [role, a] = LINES[name];
    return rgba(role, a);
};
export const radius = key => px(RADIUS_RATIO[key]);
export const shadow = (name, xOffset = 0) => {
    const [y, blur, spread, role, a] = SHADOW[name];
    return `${xOffset}px ${y}px ${blur}px ${spread}px ${rgba(role, a)}`;
};

export function appColor(name) {
    const s = name || '';
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return color(APP_COLORS[Math.abs(h) % APP_COLORS.length]);
}

export const C = {
    get accent() { return color('accent'); },
    get muted() { return color('textMuted'); },
    get text() { return color('text'); },
    get danger() { return color('danger'); },
};

const t = name => `color: ${color(TEXT[name] ?? name)};`;
const bg = name => `background-color: ${surface(name)};`;
const ln = (name, w = BORDER.hair, style = 'solid') => `border: ${w}px ${style} ${line(name)};`;
const rad = key => `border-radius: ${radius(key)}px;`;
const halo = `text-shadow: 0px 0px 3px ${rgba('ink0', 1)};`;
const ring = name => `box-shadow: inset 0 0 0 1px ${line(name)};`;

function buildCss() {
    return `
/* ============================================================
   PANEL (Solarized Dark) — ported from fix-panel-order.
   ============================================================ */
#panel {
    height: ${px(3.20)}px;
    font-size: ${px(1.00)}px;
    font-weight: bold;
    ${t('textMuted')}
    background-color: ${rgba('bgDeep', 0.75)};
    border-top: ${BORDER.thin}px solid ${rgba('edge', 0.5)};
    box-shadow: none;
}
#panel .panel-button {
    ${t('textMuted')}
    font-size: ${px(1.00)}px;
    border-radius: ${px(0.45)}px;
    margin: ${px(0.30)}px ${px(0.13)}px;
    padding: 0 ${px(0.50)}px;
    transition-duration: 150ms;
}
#panel .panel-button:hover,
#panel .panel-button:active,
#panel .panel-button:focus,
#panel .panel-button:checked {
    background-color: ${rgba('bgRaised', 0.9)};
    ${t('text')}
}
#panel .panel-button .system-status-icon,
#panel .panel-button .app-menu-icon,
#panel .panel-button StIcon {
    icon-size: ${px(1.00)}px;
}

.topnotch-tooltip { ${bg('tooltip')} ${t('tooltip')} ${ln('searchFocus', BORDER.thick)} ${rad('md')} box-shadow: ${shadow('drop')}; }
.overlay-search-entry { ${bg('searchEntry')} ${t('searchEntry')} ${ln('searchEntry', BORDER.thin)} ${rad('lg')} caret-color: ${color('text')}; selection-background-color: ${color('accent')}; selected-color: ${color('textOnAccent')}; }
.overlay-search-entry:focus { border-color: ${line('searchFocus')}; box-shadow: 0 0 0 3px ${rgba('accent', 0.45)}; }
.overlay-search-icon { ${t('searchIcon')} }
.overlay-search-hint { ${t('searchHint')} }

.workspace-thumbnail { ${bg('thumb')} ${ln('thumb')} ${rad('sm')} box-shadow: inset 0 0 0 2px ${line('thumbRing')}; }
.workspace-thumbnail:hover { ${bg('thumbHover')} }
.workspace-thumbnail.active { ${bg('thumbActive')} box-shadow: inset 0 0 0 2px ${line('thumbActive')}; }
.workspace-thumbnail.drop-target { ${bg('thumbDrop')} box-shadow: inset 0 0 0 2px ${line('dragSource')}; }

.workspace-name-label { ${t('workspaceName')} }

/* Reserve the underline slot on every icon so focus moves never shift layout.
   Square bottom corners render the underline as a flat bar, not a smile. */
.window-preview-icon,
.ws-app-group {
    border-bottom: ${BORDER.frame}px solid transparent;
    border-radius: ${radius('xs')}px ${radius('xs')}px 0 0;
}
.window-preview-icon.focused,
.ws-app-group.focused { border-bottom-color: ${line('focusPill')}; }
.window-preview-icon.pick,
.ws-app-group.pick {
    border-bottom-color: ${color('accentBright')};
    background-color: ${rgba('accent', 0.28)};
}
.ws-app-group:hover, .workspace-toolbar-button:hover { ${bg('groupHover')} }
.ws-badge { background-color: ${color('badgeBg')}; border: 1px solid ${color('textStrong')}; box-shadow: 0 1px 3px ${rgba('black', 0.65)}; }
.ws-badge-label { color: ${color(TEXT.badgeLabel)}; }

.ws-flyout { ${bg('flyout')} ${ln('flyout')} ${rad('xl')} box-shadow: ${shadow('glow')}; }
.ws-flyout-head { ${t('flyoutHead')} }
.ws-flyout-row { ${bg('flyoutRow')} border: 1px solid transparent; ${rad('lg')} }
.ws-flyout-row.sel { ${bg('flyoutRowSel')} border-color: ${line('flyoutRowSel')}; }
.ws-flyout-row-title { ${t('flyoutRowTitle')} }
.ws-flyout-row-app { ${t('flyoutRowApp')} }
.ws-flyout-row-badge { ${t('flyoutBadge')} ${bg('flyoutRowBadge')} ${rad('lg')} }
.ws-flyout-cancel { ${bg('cancelZone')} ${ln('cancelZone', BORDER.thin, 'dashed')} ${rad('lg')} border-color: ${rgba('warn', 0.75)}; }
.ws-flyout-cancel.active { ${bg('cancelZoneActive')} border-style: solid; }
.ws-flyout-cancel-label { ${t('cancelLabel')} }
.ws-flyout-edge-label { ${t('flyoutEdge')} }
.ws-flyout-edge.active .ws-flyout-edge-label { ${t('flyoutEdgeActive')} }

.ws-flyout-rail-track { background-color: ${rgba('text', 0.55)}; border-radius: 3px; box-shadow: 0 0 0 2px ${rgba('shadow', 0.6)}; }
.ws-flyout-rail-tick { border-radius: 3px; box-shadow: 0 0 0 2px ${rgba('shadow', 0.8)}; }
.ws-flyout-rail-marker { background-color: ${color('textStrong')}; border-radius: 6px; box-shadow: 0 0 0 3px ${rgba('shadow', 0.8)}; }
.selector-rail-track { background-color: ${rgba('text', 0.55)}; border-radius: 2px; box-shadow: 0 0 4px 1px ${rgba('shadow', 0.7)}; }
.selector-rail-tick { border-radius: 2px; box-shadow: 0 0 2px 1px ${rgba('shadow', 0.85)}; }
.selector-rail-marker { background-color: ${color('textBright')}; border-radius: 4px; box-shadow: 0 0 6px 2px ${rgba('shadow', 0.9)}; }

.selector-tint { ${bg('selectorTint')} }
.window-selector-overlay.selector-cancelling .selector-tint { ${bg('selectorTintCancel')} }

.selector-list {
    ${bg('selectorList')}
    border: ${BORDER.thin}px solid ${line('selectorListEdge')};
    ${rad('xl')}
    box-shadow: ${shadow('panel')};
}

.selector-band { }
.selector-band-title-label { ${t('selectorTitle')} ${halo} }
.selector-band-app-label { ${t('selectorApp')} ${halo} }

.selector-row-inner { ${rad('md')} }
.selector-row-label { ${t('selectorRow')} ${halo} }

.selector-rail { ${bg('selectorRail')} border-radius: ${radius('lg')}px; ${ring('selectorEdgeSoft')} }
.selector-rail-tip { ${bg('selectorTip')} ${t('selectorTitle')} ${rad('sm')} ${ring('selectorEdge')} ${halo} }

.window-selector-overlay .overlay-search-entry {
    ${bg('searchEntry')}
    ${t('selectorEntry')}
    ${halo}
    border: ${BORDER.thin}px solid ${rgba('textMuted', 0.6)};
    ${rad('lg')}
    padding: 14px 32px;
    caret-color: ${color('accentBright')};
    transition-duration: 150ms;
}
.window-selector-overlay .overlay-search-entry:focus {
    border-color: ${line('searchFocus')};
    box-shadow: 0 0 0 4px ${rgba('accent', 0.35)};
}

.launcher-overlay { ${bg('launcher')} }
.launcher-heading { ${t('launcherHeading')} }
.launcher-divider { background-color: ${line('divider')}; }
.launcher-tile { ${rad('lg')} border: 2px solid transparent; }
.launcher-tile:hover { ${bg('launcherTileHover')} }
.launcher-tile.focused { ${bg('launcherTileFocus')} border-color: ${line('focusRing')}; }
.launcher-tile-label { ${t('launcherTile')} }
.launcher-pinned-fade-left  { background-gradient-start: ${rgba('bgDeep', 0.97)}; background-gradient-end: ${rgba('bgDeep', 0)}; }
.launcher-pinned-fade-right { background-gradient-start: ${rgba('bgDeep', 0)};    background-gradient-end: ${rgba('bgDeep', 0.97)}; }
.launcher-scroll StScrollBar StBin#trough { background-color: ${rgba('edge', 0.3)}; border-radius: 6px; }
.launcher-scroll StScrollBar StButton#vhandle { background-color: ${rgba('textMuted', 0.8)}; border-radius: 6px; }
.launcher-scroll StScrollBar StButton#vhandle:hover { background-color: ${color('text')}; }

.dmenu-overlay { ${bg('dmenuOverlay')} }
.dmenu-panel { ${bg('dmenuPanel')} border: 1px solid ${color('base02')}; ${rad('xl')} box-shadow: ${shadow('panel')}; }
.dmenu-result-row { ${bg('dmenuRow')} border: 1px solid transparent; ${rad('lg')} }
.dmenu-result-row:hover { ${bg('dmenuRowHover')} }
.dmenu-result-row.sel { ${bg('dmenuRowSel')} border-color: ${line('flyoutRowSel')}; }
.dmenu-result-label { ${t('dmenuRow')} }
.dmenu-result-row.sel .dmenu-result-label,
.dmenu-result-row.selected .dmenu-result-label { ${t('dmenuRowSel')} }
.dmenu-result-row.selected { background-color: ${color('tealSel')}; border-color: ${color('tealSelEdge')}; }
.dmenu-result-row.selected.sel { border-color: ${line('searchFocus')}; }
.dmenu-badge { color: ${color('tealBadge')}; border: 1px solid ${color('tealBadgeEdge')}; ${rad('sm')} }
.dmenu-empty { ${t('dmenuEmpty')} }
.dmenu-section-label, .dmenu-section-count { ${t('dmenuSection')} }
.dmenu-control-row { background-color: ${color('tealRow')}; border: 1px solid ${color('tealRowEdge')}; ${rad('md')} }
.dmenu-control-name { ${t('dmenuControl')} }
.dmenu-segmented { background-color: ${color('tealDeep')}; ${rad('md')} }
.dmenu-segment { ${t('dmenuSegment')} ${rad('sm')} border: 1px solid transparent; }
.dmenu-segment:hover { ${t('text')} }
.dmenu-segment.active { ${t('dmenuSegmentOn')} background-color: ${color('tealSeg')}; border-color: ${color('tealSegEdge')}; }
.dmenu-summary { ${t('dmenuSection')} }
.dmenu-confirm { ${t('dmenuSegmentOn')} background-color: ${color('tealBtn')}; border: 1px solid ${color('tealBtnEdge')}; ${rad('md')} }
.dmenu-confirm:hover { background-color: ${color('tealBtnHover')}; }

.focused-border  { border: ${BORDER.frame}px solid ${line('focusBorder')};  ${rad('md')} }
.selected-border { border: ${BORDER.frame}px solid ${line('selectBorder')}; ${rad('md')} }
.reorder-drag-source { ${ln('dragSource', BORDER.thick)} ${rad('sm')} }
.clone-title-overlay { ${bg('cloneTitle')} color: ${color('textStrong')}; ${rad('xs')} }
.hover-preview-wrapper { border: ${BORDER.thick}px solid ${color('info')}; background-color: ${color('info')}; ${rad('md')} }
.window-close-button { background-color: ${rgba('danger', 0.85)}; ${rad('xs')} }
.window-close-button:hover { background-color: ${color('danger')}; }

.reorder-bar { background-color: ${color('info')}; border-radius: 3px; box-shadow: 0 0 10px ${rgba('info', 0.8)}; }

.pinned-edge-dash { ${bg('dash')} ${ln('dash')} border-left-width: 0; border-radius: 0 ${radius('xl')}px ${radius('xl')}px 0; box-shadow: ${shadow('edge', 6)}; }
.pinned-edge-dash .app-grid-running-dot { background-color: ${color('accent')}; }
.pinned-edge-dash .overview-tile:hover,
.pinned-edge-dash .app-well-app:hover,
.pinned-edge-dash .show-apps:hover { ${bg('dashItemHover')} }
.pinned-edge-menu .popup-menu-content { ${bg('menu')} ${ln('menu', BORDER.thin)} ${rad('lg')} box-shadow: ${shadow('drop')}; min-width: 180px; }
.pinned-edge-menu .popup-menu-item { ${t('menuItem')} ${rad('md')} }
.pinned-edge-menu .popup-menu-item:hover { ${bg('menuItemHover')} color: ${color('textStrong')}; }
.pinned-edge-menu .popup-menu-item:insensitive { ${t('menuItemDisabled')} }
`;
}

const _css = createCssLoader('topnotch-theme', buildCss);
const _listeners = new Set();
let _settings = null;
let _ids = [];

export function onThemeChanged(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }

function _refresh() {
    _css.apply();
    for (const cb of [..._listeners]) {
        try { cb(); } catch (e) { console.error(`[theme] listener: ${e.message}`); }
    }
}

export function initTheme(settings = null) {
    _settings = settings;
    const read = () => {
        const schema = settings?.settings_schema;
        _glass = schema?.has_key('glass-strength')
            ? settings.get_int('glass-strength') / 100 : GLASS_DEFAULT;
    };
    read();
    _css.apply();

    if (settings && settings.settings_schema.has_key('glass-strength'))
        _ids.push(settings.connect('changed::glass-strength', () => { read(); _refresh(); }));
}

export const refreshTheme = _refresh;

export function destroyTheme() {
    for (const id of _ids) _settings?.disconnect(id);
    _ids = [];
    _settings = null;
    _listeners.clear();
    _css.destroy();
}