// ==================== FUZZY MATCHING ====================
// Used by WindowSearchOverlay's search box.

function subsequenceMatch(query, text) {
    let qi = 0, score = 0, consecutive = 0;
    for (let ti = 0; ti < text.length && qi < query.length; ti++) {
        if (text[ti] === query[qi]) {
            score += 1 + consecutive;
            consecutive++;
            qi++;
        } else {
            consecutive = 0;
        }
    }
    if (qi < query.length)
        return { matched: false, score: -1 };
    return { matched: true, score };
}

// Token-based fuzzy match: query is split on whitespace, each token must
// appear (substring, falling back to fuzzy subsequence) somewhere in the
// text. This is what lets "ext js" match "extension.js — VS Code" even
// though there's no literal space in that position in the text.
export function fuzzyMatch(query, text) {
    const trimmed = query.trim();
    if (!trimmed)
        return { matched: true, score: 0 };
    const lowerText = text.toLowerCase();
    const tokens = trimmed.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    let score = 0;
    for (const token of tokens) {
        const idx = lowerText.indexOf(token);
        if (idx !== -1) {
            score += 50 - Math.min(idx, 40);
            continue;
        }
        const sub = subsequenceMatch(token, lowerText);
        if (!sub.matched)
            return { matched: false, score: -1 };
        score += sub.score;
    }
    return { matched: true, score };
}