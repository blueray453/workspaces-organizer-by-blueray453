// Fuzzy string matching for the search overlays. Pure: no imports, no state,
// no actors. Both WindowSearchOverlay and AppSearchOverlay run their queries
// through fuzzyMatch. Returns matched character offsets so callers can bold
// them in their markup.
//
// Order of attempts per token: substring > subsequence > typo-tolerant
// word-prefix.

function subsequenceMatch(token, text) {
    const positions = [];
    let qi = 0, score = 0, consecutive = 0;
    for (let ti = 0; ti < text.length && qi < token.length; ti++) {
        if (text[ti] === token[qi]) { score += 1 + consecutive; consecutive++; qi++; positions.push(ti); }
        else consecutive = 0;
    }
    return qi < token.length ? { matched: false } : { matched: true, score, positions };
}

// Optimal-string-alignment distance (insert / delete / substitute / transpose).
function osaDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}

function typoMatch(token, text) {
    if (token.length < 4) return null;
    const limit = token.length >= 6 ? 2 : 1;
    for (const m of text.matchAll(/[^\s\-_.\/:—]+/g)) {
        const word = m[0];
        for (let len = token.length - 1; len <= token.length + 1; len++) {
            if (len < 1 || len > word.length) continue;
            if (osaDistance(token, word.slice(0, len)) <= limit) {
                const positions = [];
                for (let i = 0; i < word.length; i++) positions.push(m.index + i);
                return { score: 10, positions };
            }
        }
    }
    return null;
}

export function fuzzyMatch(query, text) {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const indices = new Set();
    if (tokens.length === 0) return { matched: true, score: 0, indices };

    const lower = text.toLowerCase();
    let score = 0;
    for (const token of tokens) {
        const idx = lower.indexOf(token);
        if (idx !== -1) {
            const boundary = idx === 0 || /[\s\-_.\/]/.test(lower[idx - 1]);
            score += 60 - Math.min(idx, 40) + (boundary ? 20 : 0);
            for (let i = idx; i < idx + token.length; i++) indices.add(i);
            continue;
        }
        const sub = subsequenceMatch(token, lower);
        if (sub.matched) { score += sub.score; sub.positions.forEach(p => indices.add(p)); continue; }
        const typo = typoMatch(token, lower);
        if (!typo) return { matched: false, score: -1, indices: new Set() };
        score += typo.score;
        typo.positions.forEach(p => indices.add(p));
    }
    return { matched: true, score, indices };
}
