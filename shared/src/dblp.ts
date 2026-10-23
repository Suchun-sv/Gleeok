import type { Creator } from './library.ts';

/**
 * Looking papers up in DBLP through its SPARQL endpoint (sparql.dblp.org, QLever), which stays
 * open to programs while dblp.org's pages and search API sit behind a bot check. Title search
 * uses QLever's text index (every chosen word must appear) and ranks candidates here, since the
 * index does not rank; details are a few small queries on the chosen record.
 */

export const DBLP_SPARQL = 'https://sparql.dblp.org/sparql';

const PREFIXES = `PREFIX dblp: <https://dblp.org/rdf/schema#>
PREFIX ql: <http://qlever.cs.uni-freiburg.de/builtin-functions/>`;

const STOPWORDS = new Set(
  'a an and are as at be by for from has have how in into is it its of on or our the their this to towards toward via vs we what when where which with without you your all can do not'.split(' '),
);

export function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

/** The words a search requires: the most distinctive (longest, not stop words) few. */
function searchWords(title: string, count: number): string[] {
  const words = [...new Set(titleWords(title).filter((w) => !STOPWORDS.has(w)))];
  return words.sort((a, b) => b.length - a.length).slice(0, count);
}

/** Candidate records whose titles contain the chosen words; fewer words widen the net. */
export function searchQuery(title: string, wordCount: number): string | null {
  const words = searchWords(title, wordCount);
  if (words.length === 0) return null;
  return `${PREFIXES}
SELECT ?p ?title ?year ?venue ?type WHERE {
  ?p dblp:title ?title .
  ?text ql:contains-entity ?title .
${words.map((w) => `  ?text ql:contains-word "${w}" .`).join('\n')}
  OPTIONAL { ?p dblp:yearOfPublication ?year }
  OPTIONAL { ?p dblp:publishedIn ?venue }
  OPTIONAL { ?p dblp:bibtexType ?type }
} LIMIT 400`;
}

export interface DblpCandidate {
  /** DBLP record key, e.g. conf/nips/VaswaniSPUJGKP17. */
  key: string;
  title: string;
  year?: string;
  venue?: string;
  /** CoRR (arXiv) records, which DBLP keeps beside the published version. */
  preprint: boolean;
  /** 0..1 title similarity to what was searched. */
  score: number;
}

type Binding = Record<string, { value: string } | undefined>;
export interface SparqlResult {
  results: { bindings: Binding[] };
}

const recKey = (iri: string) => iri.replace(/^https:\/\/dblp\.org\/rec\//, '');
const stripDot = (t: string) => t.replace(/\.\s*$/, '');

/** Ranked candidates: the closest titles first, and a published version before its preprint. */
export function rankCandidates(searched: string, result: SparqlResult): DblpCandidate[] {
  const want = titleWords(searched);
  const wantSet = new Set(want);
  const byKey = new Map<string, DblpCandidate>();
  for (const b of result.results.bindings) {
    const key = recKey(b.p?.value ?? '');
    if (!key || byKey.has(key)) continue;
    const title = stripDot(b.title?.value ?? '');
    const got = titleWords(title);
    const common = got.filter((w) => wantSet.has(w)).length;
    const exact = got.join(' ') === want.join(' ');
    const score = exact ? 1 : (2 * common) / (got.length + want.length || 1);
    const venue = b.venue?.value;
    byKey.set(key, { key, title, year: b.year?.value, venue, preprint: venue === 'CoRR' || key.startsWith('journals/corr/'), score });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score || Number(a.preprint) - Number(b.preprint) || Number(b.year ?? 0) - Number(a.year ?? 0));
}

/** A candidate safe to apply without asking: the same title, preferring the published version. */
export function confidentMatch(candidates: DblpCandidate[]): DblpCandidate | undefined {
  return candidates.find((c) => c.score === 1);
}

/** The record's own properties, its authors in order, and the volume it appeared in. */
export function detailQueries(key: string): { record: string; authors: string; parent: string } {
  const rec = `<https://dblp.org/rec/${key}>`;
  return {
    record: `SELECT ?prop ?val WHERE { ${rec} ?prop ?val }`,
    authors: `${PREFIXES}
SELECT ?ord ?name WHERE { ${rec} dblp:hasSignature ?s . ?s dblp:signatureOrdinal ?ord . ?s dblp:signatureDblpName ?name } ORDER BY ?ord`,
    parent: `${PREFIXES}
SELECT ?prop ?val WHERE { ${rec} dblp:publishedAsPartOf ?b . ?b ?prop ?val }`,
  };
}

/** "Aidan N. Gomez" → first "Aidan N.", last "Gomez"; DBLP's homonym numbers ("Wei Li 0001") go. */
export function splitName(name: string): Creator {
  const clean = name.replace(/\s+\d{4}$/, '').trim();
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return { creatorType: 'author', name: clean };
  // Particles stay with the last name: "Ludwig van Beethoven", "Yann Le Cun".
  let i = parts.length - 1;
  while (i > 1 && /^(van|von|der|den|de|del|della|di|da|le|la|du|dos|das|ter|ten)$/i.test(parts[i - 1])) i--;
  return { creatorType: 'author', firstName: parts.slice(0, i).join(' '), lastName: parts.slice(i).join(' ') };
}

const local = (iri: string) => iri.split(/[#/]/).pop() ?? iri;

function props(result: SparqlResult): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const b of result.results.bindings) {
    const p = local(b.prop?.value ?? '');
    out.set(p, [...(out.get(p) ?? []), b.val?.value ?? '']);
  }
  return out;
}

/** Item fields (Zotero names) from the three detail queries. */
export function recordFields(key: string, record: SparqlResult, authors: SparqlResult, parent: SparqlResult): Record<string, unknown> {
  const r = props(record);
  const p = props(parent);
  const one = (m: Map<string, string[]>, k: string) => m.get(k)?.[0];
  const type = local(one(r, 'bibtexType') ?? '').toLowerCase();
  const title = stripDot(one(r, 'title') ?? '');
  const year = one(r, 'yearOfPublication');
  const pages = one(r, 'pagination')?.replace(/-+/g, '-');
  const doi = (r.get('doi') ?? []).map((d) => d.replace(/^https?:\/\/doi\.org\//, ''))[0];
  const url = one(r, 'primaryDocumentPage') ?? one(r, 'documentPage');
  const creators = authors.results.bindings.map((b) => splitName(b.name?.value ?? '')).filter((c) => c.lastName || c.name);
  const journal = one(r, 'publishedInJournal');
  const volume = one(r, 'publishedInJournalVolume');
  const base = { title, creators, date: year, url, DOI: doi, pages, dblpKey: key };

  if (journal === 'CoRR' && volume?.startsWith('abs/')) {
    const id = volume.slice(4);
    return { ...base, itemType: 'preprint', repository: 'arXiv', archiveID: `arXiv:${id}`, url: `https://arxiv.org/abs/${id}`, pages: undefined };
  }
  if (type === 'article' || journal) {
    return {
      ...base,
      itemType: 'journalArticle',
      publicationTitle: journal,
      journalAbbreviation: journal,
      volume,
      issue: one(r, 'publishedInJournalVolumeIssue'),
    };
  }
  if (type === 'inproceedings') {
    return {
      ...base,
      itemType: 'conferencePaper',
      // "ACL (1)" is volume 1 of ACL's proceedings; "EMNLP (Findings)" keeps its part.
      conferenceName: (one(r, 'publishedIn') ?? one(r, 'publishedInBook'))?.replace(/\s*\(\d+\)$/, ''),
      proceedingsTitle: stripDot(one(p, 'title') ?? '') || one(r, 'publishedInBook'),
      publisher: one(p, 'publishedBy') ?? one(p, 'publisher'),
      series: one(p, 'publishedInSeries'),
      volume: one(p, 'publishedInSeriesVolume'),
    };
  }
  if (type === 'incollection') {
    return { ...base, itemType: 'bookSection', bookTitle: stripDot(one(p, 'title') ?? '') || one(r, 'publishedInBook'), publisher: one(p, 'publishedBy') };
  }
  if (type === 'book' || type === 'proceedings') {
    return { ...base, itemType: 'book', publisher: one(r, 'publishedBy'), series: one(r, 'publishedInSeries'), ISBN: one(r, 'isbn') };
  }
  if (type === 'phdthesis' || type === 'mastersthesis') {
    return { ...base, itemType: 'thesis', thesisType: type === 'phdthesis' ? 'PhD thesis' : "Master's thesis", university: one(r, 'publishedBy') ?? one(r, 'school') };
  }
  return { ...base, itemType: 'document', publisher: one(r, 'publishedBy') };
}
