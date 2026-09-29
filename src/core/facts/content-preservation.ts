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
