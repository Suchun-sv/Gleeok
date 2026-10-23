import { net } from 'electron';
import {
  DBLP_SPARQL,
  confidentMatch,
  detailQueries,
  rankCandidates,
  recordFields,
  searchQuery,
  type DblpCandidate,
  type SparqlResult,
} from '../../../shared/src/dblp.ts';
import type { LibraryItem } from '../../../shared/src/library.ts';
import type { LibraryClient } from './library.ts';

const USER_AGENT = 'Gleeok (https://github.com/Suchun-sv/Gleeok)';
/** DBLP is a free service: queries go one at a time with a little room between them. */
const GAP_MS = 300;
let queue: Promise<unknown> = Promise.resolve();
let lastAt = 0;

function sparql(query: string): Promise<SparqlResult> {
  const run = async () => {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    const url = `${DBLP_SPARQL}?query=${encodeURIComponent(query)}`;
    const res = await net.fetch(url, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`DBLP 返回 ${res.status}`);
    return (await res.json()) as SparqlResult;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** Candidates for a title: start strict (more words must match) and loosen when that finds nothing close. */
export async function dblpSearch(title: string): Promise<DblpCandidate[]> {
  for (const words of [5, 3, 2]) {
    const q = searchQuery(title, words);
    if (!q) return [];
    const ranked = rankCandidates(title, await sparql(q));
    if (ranked.length && (ranked[0].score >= 0.6 || words === 2)) return ranked.slice(0, 8);
  }
  return [];
}

/** Fill an item from a DBLP record: its bibliographic fields are replaced, tags, notes, collections stay. */
export async function dblpApply(library: LibraryClient, itemKey: string, dblpKey: string): Promise<LibraryItem> {
  const q = detailQueries(dblpKey);
  const record = await sparql(q.record);
  if (record.results.bindings.length === 0) throw new Error(`DBLP 里找不到 ${dblpKey}`);
  const fields = recordFields(dblpKey, record, await sparql(q.authors), await sparql(q.parent));
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)));
  return library.patch<LibraryItem>('items', itemKey, clean);
}

/** For each item, apply DBLP's record when one has exactly its title; the rest need a human. */
export async function dblpAuto(library: LibraryClient, keys: string[]): Promise<{ filled: string[]; unsure: string[] }> {
  const filled: string[] = [];
  const unsure: string[] = [];
  for (const key of keys) {
    const title = String(library.item(key)?.title ?? '').trim();
    try {
      const match = title ? confidentMatch(await dblpSearch(title)) : undefined;
      if (match) {
        await dblpApply(library, key, match.key);
        filled.push(key);
      } else unsure.push(key);
    } catch {
      unsure.push(key);
    }
  }
  return { filled, unsure };
}
