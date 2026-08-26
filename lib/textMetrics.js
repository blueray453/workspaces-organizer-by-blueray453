// ==================== TEXT METRICS ESTIMATE ====================
// St resolves font-size (pt) into an on-screen glyph height via Pango at
// render time, but we need a search box's target pixel height *before*
// it's ever been laid out on a real stage — _buildUI() runs before
// Main.layoutManager.addChrome() has attached anything, so querying an
// actor's real theme node here isn't reliable. This is a deliberately
// simple, deterministic approximation (96dpi, a line-height multiplier
// that comfortably fits ascenders/descenders) rather than a
// pixel-perfect Pango measurement — good enough for sizing a search box
// around a user-configurable font-size setting. Shared by
// AppSearchOverlay and WindowSearchOverlay so both size their entry the
// same way.
const PT_TO_PX = 96 / 72;
const LINE_HEIGHT_FACTOR = 1.35;

export function estimateTextHeightPx(fontSizePt) {
    return Math.round(fontSizePt * PT_TO_PX * LINE_HEIGHT_FACTOR);
}

export function computeEntryHeight(fontSizePt, verticalPaddingPx) {
    return estimateTextHeightPx(fontSizePt) + 2 * verticalPaddingPx;
}
