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

/** Number of `## Facts` fence begin markers in `text`. */
export function countFactsFences(text: string): number {
  let n = 0;
  for (let i = text.indexOf(FACTS_FENCE_BEGIN); i !== -1; i = text.indexOf(FACTS_FENCE_BEGIN, i + FACTS_FENCE_BEGIN.length)) n++;
  return n;
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
  const n = countFactsFences(text);
  if (n > 1) {
    throw new Error(`DOUBLE_FACTS_FENCE: ${label} has ${n} facts fences; exactly one is allowed`);
  }
}

/**
 * Count GENUINE facts fences: begin markers on their own line and outside
 * fenced code blocks (same scan as extract-facts.ts
 * timelineHasGenuineFactsFenceMarker), so a page that merely documents the
 * marker syntax in a code example is not treated as double-fenced.
 */
export function countGenuineFactsFences(text: string): number {
  if (!text.includes(FACTS_FENCE_BEGIN)) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  const OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  const CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  let n = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = OPEN_RE.exec(line);
    if (open) {
      const marker = open[1]!;
      const fenceChar = marker[0]!;
      if (!(fenceChar === '`' && open[2]!.trim().includes('`'))) {
        let j = i + 1;
        for (; j < lines.length; j++) {
          const close = CLOSE_RE.exec(lines[j]!);
          if (close && close[1]![0] === fenceChar && close[1]!.length >= marker.length) {
            j++;
            break;
          }
        }
        i = j;
        continue;
      }
    }
    if (line.trim() === FACTS_FENCE_BEGIN) n++;
    i++;
  }
  return n;
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
