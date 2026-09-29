/**
 * Content-guard audit log. JSONL, ISO-week-rotated, best-effort.
 *
 * The page-wipe incident (2026-09-24): `writeFactsToFence` stub-created a
 * canonical file for a page that existed only in the DB, and the #4872 mirror
 * then copied the stub's body over the DB row — 63 entity pages lost their
 * prose. The stub-guard audit (`stub-guard-*.jsonl`) logs only REFUSALS, so
 * "0 stub-guard events" proved nothing about successful destructive writes.
 *
 * This log records both sides, one line per event, to
 *   `${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/content-guard-YYYY-Www.jsonl`
 *
 *   - `stub_created`          fence write created a brand-new stub page file
 *                             (no DB row existed for the slug).
 *   - `materialized_from_db`  fence write found a DB-only page and wrote the
 *                             DB body + timeline to disk before appending.
 *   - `preservation_blocked`  fence write refused: the candidate file would
 *                             drop existing non-fence body/timeline content.
 *   - `shrink_blocked`        sync/import refused to shrink a page's
 *                             non-fence content by more than half.
 *
 * `gbrain doctor` reads the last 24h (`content_guard_24h`). Same 2-file
 * (current + previous ISO week) read as stub-guard-audit.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from '../minions/handlers/shell-audit.ts';
import { computeStubGuardAuditFilename } from './stub-guard-audit.ts';

export type ContentGuardKind =
  | 'stub_created'
  | 'materialized_from_db'
  | 'preservation_blocked'
  | 'shrink_blocked';

export interface ContentGuardEvent {
  ts: string;
  kind: ContentGuardKind;
  slug: string;
  source_id: string;
  /** Non-fence content length (whitespace-collapsed) before the write. */
  before_chars?: number;
  /** Non-fence content length (whitespace-collapsed) the write would leave. */
  after_chars?: number;
  /** Which baseline the candidate was checked against. */
  baseline?: 'file' | 'db';
  /** Free-form detail (reason for a block). */
  detail?: string;
}

export function computeContentGuardAuditFilename(now: Date = new Date()): string {
  return computeStubGuardAuditFilename(now).replace(/^stub-guard-/, 'content-guard-');
}

export function logContentGuardEvent(event: Omit<ContentGuardEvent, 'ts'>): void {
  const dir = resolveAuditDir();
  const fullPath = path.join(dir, computeContentGuardAuditFilename());
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fullPath, line, { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[content-guard-audit] write failed (${msg}); continuing\n`);
  }
}

export function readRecentContentGuardEvents(
  opts: { sinceMs: number; now?: Date } = { sinceMs: 24 * 60 * 60 * 1000 },
): ContentGuardEvent[] {
  const now = opts.now ?? new Date();
  const dir = resolveAuditDir();
  const currentFile = computeContentGuardAuditFilename(now);
  const prevFile = computeContentGuardAuditFilename(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const files = currentFile === prevFile ? [currentFile] : [prevFile, currentFile];
  const cutoffMs = now.getTime() - opts.sinceMs;
  const events: ContentGuardEvent[] = [];
  for (const filename of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, filename), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as ContentGuardEvent;
        if (!obj.ts || !obj.slug || !obj.kind) continue;
        const eventMs = Date.parse(obj.ts);
        if (isNaN(eventMs) || eventMs < cutoffMs) continue;
        events.push(obj);
      } catch {
        // Ignore malformed lines.
      }
    }
  }
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return events;
}
