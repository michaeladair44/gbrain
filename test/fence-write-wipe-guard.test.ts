/**
 * Page-wipe incident 2026-09-24 (incidents/2026-09-24-fact-mining-page-wipe).
 *
 * A fact-mining run called writeFactsToFence for 63 entity pages that existed
 * only in the DB. The stub-create branch wrote a bare stub file, and the
 * #4872 mirror immediately copied the stub body (and an empty timeline) over
 * the DB row. These tests pin the substrate fix (restore plan v2, step 8):
 *
 *   T1  a DB-only page is materialized from the DB, never stubbed over
 *   T2  a slug with no DB row keeps the existing stub-create behavior
 *   T3  the pre-rename preservation guard + sync-side shrink guard block the
 *       wipe, write their audit lines, and leave disk / DB / fact ids alone
 *   T4  a verbatim fence round trip reconciles with factsDeleted = 0 and the
 *       same fact ids
 *   T5  a page with two facts fences hard-fails (restore build assert + the
 *       fence writer)
 *
 * Real PGLite + real filesystem under a per-test tempdir.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import type { FenceInputFact } from '../src/core/facts/fence-write.ts';
import { readRecentContentGuardEvents } from '../src/core/facts/content-guard-audit.ts';
import { assertSingleFactsFence, countFactsFenceMarkers, nonFenceContent } from '../src/core/facts/content-preservation.ts';
import { countDbOnlyPages } from '../src/core/facts/db-only-pages.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable, upsertFactRow } from '../src/core/facts-fence.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { gbrainPath } from '../src/core/config.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = (sql: string, params: unknown[] = []) => (engine as any).db.query(sql, params);

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'fence-wipe-guard-'));
  _resetWriteThroughCacheForTest();
  await q(`DELETE FROM config WHERE key = 'sync.write_through'`);
  await q('DELETE FROM fact_withdrawals');
  await q('DELETE FROM facts');
  await q('DELETE FROM pages');
  await q(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
});

const fact = (text: string): FenceInputFact => ({
  fact: text,
  kind: 'fact',
  notability: 'high',
  source: 'mcp:remember',
  visibility: 'world',
  confidence: 1.0,
  validFrom: new Date(Date.UTC(2026, 8, 24)),
  embedding: null,
  sessionId: null,
});

const RICH_BODY = [
  '# Dana Rich',
  '',
  'Dana runs platform engineering at Initech and has been a close collaborator since 2021.',
  '',
  '## Background',
  '',
  'Previously led infra at Globex; strong opinions on Postgres operations.',
].join('\n');
const RICH_TIMELINE = [
  '- **2026-03-01** | Met at the SF infra meetup.',
  '- **2026-06-12** | Intro call about the migration project.',
].join('\n');

async function seedDbOnlyPage(slug: string): Promise<void> {
  await engine.putPage(slug, {
    title: 'Dana Rich',
    type: 'person',
    compiled_truth: RICH_BODY,
    timeline: RICH_TIMELINE,
    frontmatter: { company: 'Initech' },
  }, { sourceId: 'default' });
  await engine.addTag(slug, 'vip', { sourceId: 'default' });
}

const target = (slug: string) => ({
  sourceId: 'default',
  localPath: brainDir,
  slug,
  resolutionSource: 'exact_page' as const,
});

async function factRows(slug: string): Promise<Array<{ id: number; row_num: number; fact: string }>> {
  const r = await q(
    `SELECT id, row_num, fact FROM facts WHERE source_markdown_slug = $1 ORDER BY row_num`,
    [slug],
  );
  return r.rows;
}

function eventsFor(slug: string) {
  return readRecentContentGuardEvents({ sinceMs: 60 * 60 * 1000 }).filter((e) => e.slug === slug);
}

function fenceBlock(text: string): string {
  const b = text.indexOf(FACTS_FENCE_BEGIN);
  const e = text.indexOf(FACTS_FENCE_END, b);
  return text.slice(b, e + FACTS_FENCE_END.length);
}

describe('T1 — DB-only page is materialized from the DB, not stubbed', () => {
  test('file carries body + fence + timeline; DB body and timeline are preserved', async () => {
    const slug = 'people/dana-rich';
    await seedDbOnlyPage(slug);
    const filePath = join(brainDir, `${slug}.md`);
    expect(existsSync(filePath)).toBe(false);

    const r = await writeFactsToFence(engine, target(slug), [fact('Dana joined Initech in 2021')]);
    expect(r.inserted).toBe(1);
    expect(r.fenceWriteFailed).toBeUndefined();
    expect(r.preservationGuardBlocked).toBeUndefined();

    const file = readFileSync(filePath, 'utf-8');
    expect(file).toContain('Dana runs platform engineering at Initech');
    expect(file).toContain('## Background');
    expect(file).toContain('Met at the SF infra meetup.');
    expect(file).toContain('Dana joined Initech in 2021');
    expect(file).toContain('company: Initech');
    expect(file).toContain('vip'); // source-scoped tags carried into frontmatter (C7)
    expect(countFactsFenceMarkers(file)).toBe(1);

    // The fence lands in compiled_truth (above the timeline sentinel), so
    // the extract_facts reconcile can see it.
    const parsed = parseMarkdown(file, `${slug}.md`);
    expect(parsed.compiled_truth).toContain(FACTS_FENCE_BEGIN);
    expect(parsed.timeline).not.toContain(FACTS_FENCE_BEGIN);

    // The #4872 mirror now carries the materialized content, not a stub.
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('Dana runs platform engineering at Initech');
    expect(page!.compiled_truth).toContain('Previously led infra at Globex');
    expect(page!.compiled_truth).toContain('Dana joined Initech in 2021');
    expect(page!.timeline).toContain('Met at the SF infra meetup.');
    expect(page!.timeline).toContain('Intro call about the migration project.');
    expect(nonFenceContent(page!.compiled_truth, page!.timeline)).toBe(nonFenceContent(RICH_BODY, RICH_TIMELINE));
    expect(page!.title).toBe('Dana Rich');
    expect(page!.type).toBe('person');

    // Success instrumentation (Codex C11).
    const ev = eventsFor(slug);
    expect(ev.map((e) => e.kind)).toContain('materialized_from_db');

    // A later sync of the materialized file keeps the prose.
    const imp = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    expect(imp.status).not.toBe('error');
    const after = await engine.getPage(slug, { sourceId: 'default' });
    expect(after!.compiled_truth).toContain('Previously led infra at Globex');
    expect(after!.timeline).toContain('Met at the SF infra meetup.');
  });

  test('doctor DB-only count sees the page before the write and not after', async () => {
    const slug = 'people/dana-rich';
    await seedDbOnlyPage(slug);
    const before = (await countDbOnlyPages(engine)).find((c) => c.source_id === 'default')!;
    expect(before.db_only_pages).toBe(1);
    expect(before.sample).toContain(slug);
    await writeFactsToFence(engine, target(slug), [fact('Dana joined Initech in 2021')]);
    const after = (await countDbOnlyPages(engine)).find((c) => c.source_id === 'default')!;
    expect(after.db_only_pages).toBe(0);
  });
});

describe('T2 — slug with no DB row still stub-creates', () => {
  test('stub page file, fence, fact row; audit records stub_created', async () => {
    const slug = 'people/new-person';
    const r = await writeFactsToFence(engine, target(slug), [fact('New Person founded a startup')]);
    expect(r.inserted).toBe(1);
    const file = readFileSync(join(brainDir, `${slug}.md`), 'utf-8');
    expect(file).toContain('type: person');
    expect(file).toContain(`slug: ${slug}`);
    expect(file).toContain('# New Person');
    expect(file).toContain('New Person founded a startup');
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull(); // sync creates the row
    expect(eventsFor(slug).map((e) => e.kind)).toContain('stub_created');
  });

  test('fallback-resolved slug is still refused by the stub guard', async () => {
    const slug = 'companies/invented-co';
    const r = await writeFactsToFence(
      engine,
      { ...target(slug), resolutionSource: 'fallback_slugify' },
      [fact('Invented Co raised money')],
    );
    expect(r.stubGuardBlocked).toBe(true);
    expect(existsSync(join(brainDir, `${slug}.md`))).toBe(false);
  });
});

describe('T3 — guards block the wipe and write the audit line', () => {
  test('pre-rename preservation guard: stub file over a rich DB row is refused; disk, DB and fact ids unchanged', async () => {
    const slug = 'people/dana-rich';
    await seedDbOnlyPage(slug);
    // Seed one fence-owned fact via the (now safe) materialize path, then put
    // the page into the incident's state: a bare stub file on disk sitting
    // over the rich DB row (e.g. written by an unpatched binary, not synced).
    await writeFactsToFence(engine, target(slug), [fact('Dana joined Initech in 2021')]);
    const filePath = join(brainDir, `${slug}.md`);
    const stub = `---\ntype: person\ntitle: Dana Rich\nslug: ${slug}\n---\n\n# Dana Rich\n\n## Facts\n\n${fenceBlock(readFileSync(filePath, 'utf-8'))}\n`;
    writeFileSync(filePath, stub, 'utf-8');

    const pageBefore = await engine.getPage(slug, { sourceId: 'default' });
    const factsBefore = await factRows(slug);
    expect(factsBefore).toHaveLength(1);

    const r = await writeFactsToFence(engine, target(slug), [fact('Dana moved to Oakland')]);
    expect(r.inserted).toBe(0);
    expect(r.fenceWriteFailed).toBe(true);
    expect(r.preservationGuardBlocked).toBe(true);

    // Disk: canonical file untouched; candidate quarantined at .tmp.
    expect(readFileSync(filePath, 'utf-8')).toBe(stub);
    expect(existsSync(`${filePath}.tmp`)).toBe(true);
    // DB body/timeline untouched (the mirror never ran).
    const pageAfter = await engine.getPage(slug, { sourceId: 'default' });
    expect(pageAfter!.compiled_truth).toBe(pageBefore!.compiled_truth);
    expect(pageAfter!.timeline).toBe(pageBefore!.timeline);
    expect(pageAfter!.content_hash).toBe(pageBefore!.content_hash);
    // Fact ids untouched, nothing inserted.
    expect(await factRows(slug)).toEqual(factsBefore);

    // Audit line (content-guard) + write-failure JSONL line.
    const blocked = eventsFor(slug).filter((e) => e.kind === 'preservation_blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked.at(-1)!.baseline).toBe('db');
    expect(blocked.at(-1)!.before_chars!).toBeGreaterThan(blocked.at(-1)!.after_chars!);
    const failures = readFileSync(gbrainPath('facts.write_failures.jsonl'), 'utf-8');
    expect(failures).toContain(slug);
    expect(failures).toContain('preservation_guard');
  });

  test('sync-side shrink guard: importing the stub over the rich row is refused unless allowShrink', async () => {
    const slug = 'people/dana-rich';
    await seedDbOnlyPage(slug);
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    const filePath = join(brainDir, `${slug}.md`);
    writeFileSync(filePath, `---\ntype: person\ntitle: Dana Rich\n---\n\n# Dana Rich\n`, 'utf-8');
    const pageBefore = await engine.getPage(slug, { sourceId: 'default' });

    const r = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    expect(r.status).toBe('skipped');
    expect(r.error).toContain('SHRINK_GUARD');
    const pageAfter = await engine.getPage(slug, { sourceId: 'default' });
    expect(pageAfter!.compiled_truth).toBe(pageBefore!.compiled_truth);
    expect(pageAfter!.timeline).toBe(pageBefore!.timeline);
    expect(eventsFor(slug).map((e) => e.kind)).toContain('shrink_blocked');

    const forced = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default', allowShrink: true });
    expect(forced.status).toBe('imported');
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).not.toContain('Globex');
  });

  test('growth and small edits import normally (guard only fires on >50% loss)', async () => {
    const slug = 'people/dana-rich';
    await seedDbOnlyPage(slug);
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    const filePath = join(brainDir, `${slug}.md`);
    const edited = RICH_BODY.replace('strong opinions on Postgres operations.', 'strong opinions on Postgres.');
    writeFileSync(filePath, `---\ntype: person\ntitle: Dana Rich\n---\n\n${edited}\n\n<!-- timeline -->\n\n${RICH_TIMELINE}\n`, 'utf-8');
    const r = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    expect(r.status).toBe('imported');
  });
});

describe('T4 — verbatim fence round trip keeps fact ids (factsDeleted = 0)', () => {
  test('materialize → sync → reconcile is a no-op on facts', async () => {
    const slug = 'people/dana-rich';
    await seedDbOnlyPage(slug);
    await writeFactsToFence(engine, target(slug), [fact('Dana joined Initech in 2021'), fact('Dana speaks Portuguese')]);
    const filePath = join(brainDir, `${slug}.md`);
    await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    const idsBefore = await factRows(slug);
    expect(idsBefore).toHaveLength(2);

    const rec = await runExtractFacts(engine, { slugs: [slug] });
    expect(rec.guardTriggered).toBe(false);
    expect(rec.factsDeleted).toBe(0);
    expect(rec.factsInserted).toBe(0);
    expect(await factRows(slug)).toEqual(idsBefore);
  });

  test('restore shape: wiped stub + fence → restored body with the fence copied byte-for-byte', async () => {
    const slug = 'people/wiped-page';
    // Reproduce the post-wipe state: stub file + fence, synced into the DB.
    await writeFactsToFence(engine, target(slug), [fact('Wiped Page runs a lab'), fact('Wiped Page lives in Berkeley')]);
    const filePath = join(brainDir, `${slug}.md`);
    await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    const idsBefore = await factRows(slug);
    expect(idsBefore).toHaveLength(2);

    // Restore: pre-wipe body + verbatim fence bytes from the current file.
    const current = readFileSync(filePath, 'utf-8');
    const fence = fenceBlock(current);
    const restored =
      `---\ntype: person\ntitle: Wiped Page\nslug: ${slug}\n---\n\n${RICH_BODY}\n\n## Facts\n\n${fence}\n\n<!-- timeline -->\n\n${RICH_TIMELINE}\n`;
    assertSingleFactsFence(restored, slug);
    expect(fenceBlock(restored)).toBe(fence);
    writeFileSync(filePath, restored, 'utf-8');
    const imp = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    expect(imp.status).toBe('imported');

    const rec = await runExtractFacts(engine, { slugs: [slug] });
    expect(rec.guardTriggered).toBe(false);
    expect(rec.factsDeleted).toBe(0);
    expect(await factRows(slug)).toEqual(idsBefore);
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('Previously led infra at Globex');
    expect(parseFactsFence(page!.compiled_truth).facts.map((f) => f.rowNum)).toEqual(idsBefore.map((f) => f.row_num));

    // A further remember on the restored page appends without touching prose or ids.
    const r = await writeFactsToFence(engine, target(slug), [fact('Wiped Page won a grant')]);
    expect(r.inserted).toBe(1);
    const rows = await factRows(slug);
    expect(rows.slice(0, 2)).toEqual(idsBefore);
    expect(readFileSync(filePath, 'utf-8')).toContain('Previously led infra at Globex');
  });
});

describe('T5 — two facts fences hard-fail', () => {
  const twoFences = (fence: string) =>
    `---\ntype: person\ntitle: Double\n---\n\n# Double\n\n## Facts\n\n${fence}\n\nOld notes.\n\n## Facts\n\n${fence}\n`;

  test('restore build assert: assertSingleFactsFence throws on two fences, passes on one', () => {
    const fence = `${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | A | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |\n${FACTS_FENCE_END}`;
    expect(() => assertSingleFactsFence(twoFences(fence), 'people/double')).toThrow(/DOUBLE_FACTS_FENCE/);
    expect(() => assertSingleFactsFence(`# One\n\n${fence}\n`)).not.toThrow();
    expect(() => assertSingleFactsFence('# None\n')).not.toThrow();
  });

  test('fence writer refuses to append to a double-fenced page; file and facts unchanged', async () => {
    const slug = 'people/double';
    await writeFactsToFence(engine, target(slug), [fact('Double has one fact')]);
    const filePath = join(brainDir, `${slug}.md`);
    const doubled = twoFences(fenceBlock(readFileSync(filePath, 'utf-8')));
    writeFileSync(filePath, doubled, 'utf-8');
    const before = await factRows(slug);

    const r = await writeFactsToFence(engine, target(slug), [fact('Double gets another')]);
    expect(r.preservationGuardBlocked).toBe(true);
    expect(r.fenceWriteFailed).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe(doubled);
    expect(await factRows(slug)).toEqual(before);
    expect(eventsFor(slug).some((e) => e.kind === 'preservation_blocked' && /2 facts fences/.test(e.detail ?? ''))).toBe(true);
  });
});

describe('Codex wipe-patch r1 regressions', () => {
  test('P1-1: a fence-only file (all prose lost, fence kept) does not bypass the sync shrink guard', async () => {
    const slug = 'people/dana-rich';
    await seedDbOnlyPage(slug);
    await writeFactsToFence(engine, target(slug), [fact('Dana joined Initech in 2021')]);
    const filePath = join(brainDir, `${slug}.md`);
    const fenceOnly = `---\ntype: person\ntitle: Dana Rich\n---\n\n${fenceBlock(readFileSync(filePath, 'utf-8'))}\n`;
    writeFileSync(filePath, fenceOnly, 'utf-8');
    const before = await engine.getPage(slug, { sourceId: 'default' });
    const r = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    expect(r.status).toBe('skipped');
    expect(r.error).toContain('SHRINK_GUARD');
    const after = await engine.getPage(slug, { sourceId: 'default' });
    expect(after!.compiled_truth).toBe(before!.compiled_truth);
  });

  test('P1-1: a literally emptied file is still a deliberate clear', async () => {
    const slug = 'people/dana-rich';
    await seedDbOnlyPage(slug);
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    const filePath = join(brainDir, `${slug}.md`);
    writeFileSync(filePath, `---\ntype: person\ntitle: Dana Rich\n---\n`, 'utf-8');
    const r = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    expect(r.status).toBe('imported');
  });

  test('P1-2: double-fenced file → sync refuses; reconcile on a double-fenced DB body keeps fact ids', async () => {
    const slug = 'people/double-sync';
    await writeFactsToFence(engine, target(slug), [fact('First'), fact('Second')]);
    const filePath = join(brainDir, `${slug}.md`);
    await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    const ids = await factRows(slug);
    expect(ids).toHaveLength(2);

    const current = readFileSync(filePath, 'utf-8');
    const fence = fenceBlock(current);
    const oldFence = fence.replace(/\| 2 \|.*\n/, '');
    const doubled = `---\ntype: person\ntitle: Double Sync\n---\n\n# Double Sync\n\n${RICH_BODY}\n\n## Facts\n\n${oldFence}\n\n## Facts\n\n${fence}\n`;
    writeFileSync(filePath, doubled, 'utf-8');
    const r = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    expect(r.status).toBe('skipped');
    expect(r.error).toContain('DOUBLE_FACTS_FENCE');
    expect(eventsFor(slug).map((e) => e.kind)).toContain('double_fence_blocked');

    // Even if a double-fenced body reaches the DB by another path, the
    // reconcile refuses to act on it.
    await engine.putPage(slug, { title: 'Double Sync', type: 'person', compiled_truth: `# Double Sync\n\n${oldFence}\n\n${fence}\n`, timeline: '', frontmatter: {} }, { sourceId: 'default' });
    const rec = await runExtractFacts(engine, { slugs: [slug] });
    expect(rec.factsDeleted).toBe(0);
    expect(rec.warnings.join('\n')).toContain('DOUBLE_FACTS_FENCE');
    expect(await factRows(slug)).toEqual(ids);
  });

  test('P1-3: an existing malformed fence row is never dropped by an append; disk, DB and ids unchanged', async () => {
    const slug = 'people/malformed';
    await writeFactsToFence(engine, target(slug), [fact('Good row')]);
    const filePath = join(brainDir, `${slug}.md`);
    await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    // Hand-edit a second row with an invalid row_num into the fence.
    const bad = readFileSync(filePath, 'utf-8').replace(
      FACTS_FENCE_END,
      `| x | Bad row | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |\n${FACTS_FENCE_END}`,
    );
    writeFileSync(filePath, bad, 'utf-8');
    const ids = await factRows(slug);
    const pageBefore = await engine.getPage(slug, { sourceId: 'default' });

    const r = await writeFactsToFence(engine, target(slug), [fact('Another row')]);
    expect(r.preservationGuardBlocked).toBe(true);
    expect(r.fenceWriteFailed).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe(bad);
    expect(await factRows(slug)).toEqual(ids);
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toBe(pageBefore!.compiled_truth);
  });

  test('P2: DB-only page with a bare ## Timeline section inside compiled_truth still materializes', async () => {
    const slug = 'people/bare-timeline';
    await engine.putPage(slug, {
      title: 'Bare Timeline',
      type: 'person',
      compiled_truth: '# Bare Timeline\n\nIntro prose about the person.\n\n## Timeline\n\n- **2026-01-02** | Met.\n\n## Background\n\nWorked at Hooli.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
    const r = await writeFactsToFence(engine, target(slug), [fact('Bare Timeline likes tea')]);
    expect(r.preservationGuardBlocked).toBeUndefined();
    expect(r.inserted).toBe(1);
    const file = readFileSync(join(brainDir, `${slug}.md`), 'utf-8');
    expect(file).toContain('Intro prose about the person.');
    expect(file).toContain('Met.');
    expect(file).toContain('Worked at Hooli.');
  });
});

describe('Codex wipe-patch r2 regressions', () => {
  const EXAMPLE = `${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Example claim | fact | 1.0 | world | medium | 2026-01-01 |  | docs |  |\n${FACTS_FENCE_END}`;

  test('P1-1: marker count is not code-block aware (matches parseFactsFence selection)', () => {
    const doc = `# Docs\n\n\`\`\`markdown\n${EXAMPLE}\n\`\`\`\n\n${EXAMPLE}\n`;
    expect(countFactsFenceMarkers(doc)).toBe(2);
    expect(countFactsFenceMarkers(`# Docs\n\n${EXAMPLE}\n`)).toBe(1);
    // A stray end marker makes the fence ambiguous too.
    expect(countFactsFenceMarkers(`${EXAMPLE}\n\n${FACTS_FENCE_END}\n`)).toBe(2);
    expect(() => assertSingleFactsFence(doc)).toThrow(/DOUBLE_FACTS_FENCE/);
  });

  test('P1-1: code-block example fence above the live fence → sync refuses, reconcile and writer keep live fact ids', async () => {
    const slug = 'people/code-example';
    await writeFactsToFence(engine, target(slug), [fact('Live one'), fact('Live two')]);
    const filePath = join(brainDir, `${slug}.md`);
    await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    const ids = await factRows(slug);
    expect(ids).toHaveLength(2);

    const live = fenceBlock(readFileSync(filePath, 'utf-8'));
    const withExample = `---\ntype: person\ntitle: Code Example\n---\n\n# Code Example\n\n${RICH_BODY}\n\n\`\`\`markdown\n${EXAMPLE}\n\`\`\`\n\n## Facts\n\n${live}\n`;
    writeFileSync(filePath, withExample, 'utf-8');

    const r = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    expect(r.status).toBe('skipped');
    expect(r.error).toContain('DOUBLE_FACTS_FENCE');

    const w = await writeFactsToFence(engine, target(slug), [fact('Live three')]);
    expect(w.preservationGuardBlocked).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe(withExample);

    await engine.putPage(slug, { title: 'Code Example', type: 'person', compiled_truth: `# Code Example\n\n\`\`\`markdown\n${EXAMPLE}\n\`\`\`\n\n${live}\n`, timeline: '', frontmatter: {} }, { sourceId: 'default' });
    const rec = await runExtractFacts(engine, { slugs: [slug] });
    expect(rec.factsDeleted).toBe(0);
    expect(rec.warnings.join('\n')).toContain('DOUBLE_FACTS_FENCE');
    expect(await factRows(slug)).toEqual(ids);
  });

  test('P1-2: a fence row that lost its leading pipe (no parser warning) blocks the append; disk, DB and ids unchanged', async () => {
    const slug = 'people/no-pipe';
    await writeFactsToFence(engine, target(slug), [fact('Keep one'), fact('Keep two')]);
    const filePath = join(brainDir, `${slug}.md`);
    await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    const cur = readFileSync(filePath, 'utf-8');
    const bad = cur.replace(/\n\| 2 \|/, '\n2 |');
    expect(bad).not.toBe(cur);
    writeFileSync(filePath, bad, 'utf-8');
    const ids = await factRows(slug);
    const pageBefore = await engine.getPage(slug, { sourceId: 'default' });

    const r = await writeFactsToFence(engine, target(slug), [fact('Another')]);
    expect(r.preservationGuardBlocked).toBe(true);
    expect(r.fenceWriteFailed).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe(bad);
    expect(await factRows(slug)).toEqual(ids);
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toBe(pageBefore!.compiled_truth);
    expect(eventsFor(slug).some((e) => e.kind === 'preservation_blocked' && /UNPARSED_LINE/.test(e.detail ?? ''))).toBe(true);
  });

  test('r3 P1: a pipe-less fence row survives sync → reconcile; both original fact ids are kept', async () => {
    const slug = 'people/no-pipe-sync';
    await writeFactsToFence(engine, target(slug), [fact('Keep one'), fact('Keep two')]);
    const filePath = join(brainDir, `${slug}.md`);
    await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    const ids = await factRows(slug);
    expect(ids).toHaveLength(2);

    const bad = readFileSync(filePath, 'utf-8').replace(/\n\| 2 \|/, '\n2 |');
    writeFileSync(filePath, bad, 'utf-8');
    const imp = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    expect(imp.status).toBe('imported');

    const rec = await runExtractFacts(engine, { slugs: [slug] });
    expect(rec.factsDeleted).toBe(0);
    expect(rec.warnings.join('\n')).toContain('FACTS_FENCE_UNPARSED_LINE');
    expect(await factRows(slug)).toEqual(ids);
  });
});

// Codex wipe-patch r4: the malformed-row class, fixed at the parser. A fence
// line that is not a table row warns, so every path that rewrites or
// reconciles a fence sees a non-authoritative parse and fails closed.
describe('Codex wipe-patch r4 — malformed fence rows fail closed on every path', () => {
  const brokenFence = async (slug: string) => {
    await writeFactsToFence(engine, target(slug), [fact('Keep one'), fact('Keep two')]);
    const filePath = join(brainDir, `${slug}.md`);
    await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    const ids = await factRows(slug);
    expect(ids).toHaveLength(2);
    const bad = readFileSync(filePath, 'utf-8').replace(/\n\| 2 \|/, '\n2 |');
    writeFileSync(filePath, bad, 'utf-8');
    return { filePath, bad, ids };
  };

  test('parse: a pipe-less fence line warns FACTS_FENCE_UNPARSED_LINE; a rendered fence parses clean', () => {
    const clean = renderFactsTable([
      { rowNum: 1, claim: 'A', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    ]);
    expect(parseFactsFence(clean).warnings).toEqual([]);
    const bad = clean.replace('\n| 1 |', '\n1 |');
    const parsed = parseFactsFence(bad);
    expect(parsed.facts).toHaveLength(0);
    expect(parsed.warnings.some((w) => w.startsWith('FACTS_FENCE_UNPARSED_LINE'))).toBe(true);
  });

  test('upsertFactRow refuses to re-render a fence with a pipe-less row', () => {
    const clean = renderFactsTable([
      { rowNum: 1, claim: 'A', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
      { rowNum: 2, claim: 'B', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    ]);
    const bad = clean.replace('\n| 2 |', '\n2 |');
    expect(() => upsertFactRow(bad, {
      claim: 'C', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high',
    })).toThrow(/malformed/);
  });

  test('sync: importing a file with a pipe-less row keeps the line verbatim in the DB body', async () => {
    const slug = 'people/r4-sync';
    const { filePath } = await brokenFence(slug);
    const imp = await importFromFile(engine, filePath, `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    expect(imp.status).toBe('imported');
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toContain('\n2 |');
  });

  test('forget: a fence with a pipe-less row is not rewritten; the markdown keeps both rows', async () => {
    const slug = 'people/r4-forget';
    const { filePath, bad, ids } = await brokenFence(slug);
    await forgetFactInFence(engine, ids[0].id, { reason: 'test' });
    expect(readFileSync(filePath, 'utf-8')).toBe(bad);
    const rows = await factRows(slug);
    expect(rows.map((r) => r.id)).toEqual(ids.map((r) => r.id));
  });

  test('remote write-back: a malformed existing fence is kept verbatim, not replaced by the incoming body', async () => {
    const slug = 'people/r4-remote';
    const { bad, ids } = await brokenFence(slug);
    await importFromFile(engine, join(brainDir, `${slug}.md`), `${slug}.md`, { noEmbed: true, sourceId: 'default' });
    const before = (await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth;
    const existingFence = fenceBlock(before);
    expect(existingFence).toContain('\n2 |');

    // A remote caller never sees a malformed fence (it is omitted on read),
    // so its write-back carries no fence at all.
    const incoming = parseMarkdown(bad, `${slug}.md`);
    const noFence = bad.replace(fenceBlock(bad), '');
    await importFromContent(engine, slug, noFence, { noEmbed: true, sourceId: 'default', remote: true } as never);
    const after = (await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth;
    expect(fenceBlock(after)).toBe(existingFence);
    expect(incoming.compiled_truth).toContain('\n2 |');

    const rec = await runExtractFacts(engine, { slugs: [slug] });
    expect(rec.factsDeleted).toBe(0);
    expect((await factRows(slug)).map((r) => r.id)).toEqual(ids.map((r) => r.id));
  });
});
