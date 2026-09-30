/**
 * Non-fence content measurement shared by the fence-write preservation guard
 * and the sync-side shrink guard (page-wipe incident 2026-09-24).
 *
 * "Non-fence content" = a page's compiled_truth + timeline with every
 * `## Facts` fence block (and the `## Facts` heading directly above it)
 * removed, whitespace collapsed. Fact appends only ever add/replace a fence,
 * so a fact write must leave this string byte-identical; anything else means
 * the write would destroy prose.
 */

import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';

const FACTS_HEADING_BEFORE_FENCE = new RegExp(
  `(^|\\n)[ \\t]*##[ \\t]+Facts[ \\t]*\\n\\s*(?=${FACTS_FENCE_BEGIN.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')})`,
  'g',
);

function stripAllFences(text: string): string {
  let out = text.replace(FACTS_HEADING_BEFORE_FENCE, '$1');
  for (;;) {
    const begin = out.indexOf(FACTS_FENCE_BEGIN);
    if (begin === -1) return out;
    const end = out.indexOf(FACTS_FENCE_END, begin + FACTS_FENCE_BEGIN.length);
    if (end === -1) return out;
    out = out.slice(0, begin) + out.slice(end + FACTS_FENCE_END.length);
  }
}

/** Whitespace-collapsed non-fence body + timeline. */
export function nonFenceContent(compiledTruth: string | null | undefined, timeline: string | null | undefined): string {
  const body = stripAllFences(compiledTruth ?? '');
  const tl = stripAllFences(timeline ?? '');
  return `${body}\n${tl}`.replace(/\s+/g, ' ').trim();
}

/** Minimum non-fence size (chars, whitespace-collapsed) below which a page is treated as a stub and shrink checks don't apply. */
export const SHRINK_GUARD_MIN_CHARS = 20;

/**
 * True when replacing `before` with `after` drops more than half the
 * non-fence content of a page that had real content (>= SHRINK_GUARD_MIN_CHARS).
 */
export function isDestructiveShrink(before: string, after: string): boolean {
  if (before.length < SHRINK_GUARD_MIN_CHARS) return false;
  return after.length * 2 < before.length;
}

/**
 * The double-fence trap: `parseFactsFence` reads only the FIRST fence, so a
 * page carrying an old fence above the current one makes the extract_facts
 * reconcile treat every current row as stale and delete + reinsert them all
 * (new fact ids, lost source_session, broken supersession pointers). Any
 * writer that assembles a page from pieces (the page-wipe restore build, a
 * fence append) must hard-fail on more than one fence instead of guessing.
 */
export function assertSingleFactsFence(text: string, label = 'page'): void {
  const n = countFactsFenceMarkers(text);
  if (n > 1) {
    throw new Error(`DOUBLE_FACTS_FENCE: ${label} has ${n} facts fences; exactly one is allowed`);
  }
}

/**
 * Facts-fence marker count used by every double-fence gate (import, the
 * extract_facts reconcile, the fence writer): the larger of the raw begin
 * and end marker counts, anywhere in `text` — code blocks included.
 *
 * Deliberately NOT code-block aware (Codex wipe-patch r2 P1-1):
 * parseFactsFence and upsertFactRow select the fence by raw indexOf, so a
 * marker quoted in a code example above the live fence IS the fence they
 * read and rewrite. A gate that skipped code blocks would pass exactly the
 * page the parser misreads. Any second marker is ambiguous → refuse; the
 * cost is that a page documenting the marker syntax AND carrying a live
 * fence must be fixed by hand, which never loses data.
 */
export function countFactsFenceMarkers(text: string): number {
  const count = (marker: string) => {
    let n = 0;
    for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + marker.length)) n++;
    return n;
  };
  return Math.max(count(FACTS_FENCE_BEGIN), count(FACTS_FENCE_END));
}

/**
 * Order-insensitive preservation check for materializing a DB row to disk:
 * the parser may legitimately move a bare `## Timeline` section from the
 * body into the timeline column, which reorders content without losing any.
 * Compares the whitespace-token multisets of two non-fence strings, ignoring
 * timeline separator lines the parser consumes.
 */
export function sameContentTokens(a: string, b: string): boolean {
  const tokens = (s: string) =>
    s
      .replace(/<!--\s*timeline\s*-->/gi, ' ')
      .replace(/(^|\s)---\s+timeline\s+---(?=\s|$)/gi, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0 && !/^-{3,}$/.test(t))
      .sort()
      .join(' ');
  return tokens(a) === tokens(b);
}
