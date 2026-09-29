/**
 * DB-only page exposure count (page-wipe incident 2026-09-24).
 *
 * A "DB-only" page has a live `pages` row in a source that has a
 * `local_path`, but no markdown file on disk — neither at its recorded
 * `source_path` nor at `<slug>.md`. Before the fence-write materialize fix,
 * every such page was a wipe target the moment `remember`/`extract_facts`
 * resolved an entity to it: the fence writer stub-created the file and the
 * #4872 mirror copied the stub body over the row. The fix makes the write
 * safe, but the count stays the exposure surface for `gbrain doctor`.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

import type { BrainEngine } from '../engine.ts';

export interface DbOnlyPageCount {
  source_id: string;
  local_path: string;
  total_pages: number;
  db_only_pages: number;
  /** Up to 5 example slugs, for the operator to start from. */
  sample: string[];
}

function fileExistsFor(localPath: string, slug: string, sourcePath: string | null): boolean {
  if (sourcePath) {
    const rel = normalize(sourcePath);
    if (!isAbsolute(rel) && !rel.startsWith('..') && existsSync(join(localPath, rel))) return true;
  }
  return existsSync(join(localPath, `${slug}.md`));
}

export async function countDbOnlyPages(engine: BrainEngine): Promise<DbOnlyPageCount[]> {
  const sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
    `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL ORDER BY id`,
  );
  const out: DbOnlyPageCount[] = [];
  for (const src of sources) {
    if (!src.local_path || !existsSync(src.local_path)) continue;
    const pages = await engine.executeRaw<{ slug: string; source_path: string | null }>(
      `SELECT slug, source_path FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
      [src.id],
    );
    const missing: string[] = [];
    for (const p of pages) {
      if (!fileExistsFor(src.local_path, p.slug, p.source_path)) missing.push(p.slug);
    }
    out.push({
      source_id: src.id,
      local_path: src.local_path,
      total_pages: pages.length,
      db_only_pages: missing.length,
      sample: missing.slice(0, 5),
    });
  }
  return out;
}
