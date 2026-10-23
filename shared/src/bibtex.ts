import type { Creator, LibraryItem } from './library.ts';
import { titleWords } from './dblp.ts';

/**
 * BibTeX for Overleaf: entries made from the item's fields (DBLP-quality once filled from DBLP),
 * with UTF-8 left as is (Overleaf's pdfLaTeX and XeLaTeX both read it), LaTeX's special
 * characters escaped, and capitals in titles protected so styles cannot lowercase "BERT".
 */

const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'to', 'and', 'with', 'is', 'are', 'towards', 'toward', 'via', 'from', 'by', 'at']);

const ascii = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Google Scholar style: first author's last name, year, first real title word ("vaswani2017attention").
 * `taken` holds keys already used in the library; clashes get a, b, c...
 */
export function makeCitationKey(item: LibraryItem, taken: Set<string>): string {
  const first = (item.creators ?? []).find((c) => c.creatorType === 'author') ?? item.creators?.[0];
  const name = ascii(first?.lastName ?? first?.name ?? '') || 'anon';
  const year = /\b(\d{4})\b/.exec(String(item.date ?? ''))?.[1] ?? '';
  const word = titleWords(String(item.title ?? '')).find((w) => !STOP.has(w) && /[a-z]/.test(w)) ?? '';
  const base = `${name}${year}${word}`;
  if (!taken.has(base)) return base;
  for (let i = 0; i < 26; i++) {
    const k = base + String.fromCharCode(97 + i);
    if (!taken.has(k)) return k;
  }
  return `${base}${Date.now() % 1000}`;
}

/** LaTeX's special characters, outside of math. */
export function escapeLatex(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/** Words with capitals after their first letter (BERT, LoRA, GPT-4, ImageNet) keep them. */
function protectTitle(title: string): string {
  return escapeLatex(title)
    .split(/(\s+)/)
    .map((w) => (/^[^\s]*[A-Z]/.test(w.slice(1)) && !/^\\/.test(w) ? `{${w}}` : w))
    .join('');
}

const person = (c: Creator) =>
  c.name !== undefined ? `{${escapeLatex(c.name)}}` : [c.lastName, c.firstName].filter(Boolean).map((p) => escapeLatex(p!)).join(', ');

const people = (creators: Creator[] | undefined, types: string[]) =>
  (creators ?? []).filter((c) => types.includes(c.creatorType)).map(person).join(' and ');

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** One entry. The key must already be chosen (see makeCitationKey); empty fields are left out. */
export function toBibtex(item: LibraryItem, key: string): string {
  const year = /\b(\d{4})\b/.exec(String(item.date ?? ''))?.[1];
  const pages = str(item.pages)?.replace(/\s*[-–—]+\s*/g, '--');
  const common: [string, string | undefined][] = [
    ['author', people(item.creators, ['author', 'presenter']) || undefined],
    ['title', str(item.title) && protectTitle(str(item.title)!)],
  ];
  let type = 'misc';
  let fields: [string, string | undefined][] = [];
  const t = item.itemType;
  if (t === 'conferencePaper') {
    type = 'inproceedings';
    fields = [
      ['booktitle', str(item.proceedingsTitle) ?? str(item.conferenceName)],
      ['editor', people(item.creators, ['editor']) || undefined],
      ['series', str(item.series)],
      ['volume', str(item.volume)],
      ['pages', pages],
      ['publisher', str(item.publisher)],
      ['address', str(item.place)],
    ];
  } else if (t === 'journalArticle') {
    type = 'article';
    fields = [
      ['journal', str(item.publicationTitle) ?? str(item.journalAbbreviation)],
      ['volume', str(item.volume)],
      ['number', str(item.issue)],
      ['pages', pages],
    ];
  } else if (t === 'preprint') {
    // As DBLP writes arXiv papers: an article in "CoRR", which every style prints sensibly.
    const id = str(item.archiveID)?.replace(/^arxiv:/i, '') ?? /arxiv\.org\/abs\/([^\s/?#]+)/.exec(String(item.url ?? ''))?.[1];
    type = 'article';
    fields = id
      ? [
          ['journal', 'CoRR'],
          ['volume', `abs/${id}`],
          ['eprint', id],
          ['eprinttype', 'arXiv'],
        ]
      : [['journal', str(item.repository) ?? 'Preprint']];
  } else if (t === 'book') {
    type = 'book';
    fields = [
      ['editor', people(item.creators, ['editor']) || undefined],
      ['series', str(item.series)],
      ['volume', str(item.volume)],
      ['edition', str(item.edition)],
      ['publisher', str(item.publisher)],
      ['address', str(item.place)],
      ['isbn', str(item.ISBN)],
    ];
  } else if (t === 'bookSection') {
    type = 'incollection';
    fields = [
      ['booktitle', str(item.bookTitle)],
      ['editor', people(item.creators, ['editor']) || undefined],
      ['pages', pages],
      ['publisher', str(item.publisher)],
      ['address', str(item.place)],
    ];
  } else if (t === 'thesis') {
    type = /master/i.test(String(item.thesisType ?? '')) ? 'mastersthesis' : 'phdthesis';
    fields = [['school', str(item.university)]];
  } else if (t === 'report') {
    type = 'techreport';
    fields = [
      ['institution', str(item.institution)],
      ['number', str(item.reportNumber)],
    ];
  } else {
    fields = [['howpublished', str(item.websiteTitle) ?? str(item.publisher) ?? str(item.meetingName)]];
  }
  const all: [string, string | undefined][] = [
    ...common,
    ...fields.map(([k, v]): [string, string | undefined] => [k, v && k !== 'volume' && k !== 'eprint' && k !== 'isbn' ? escapeLatex(v) : v]),
    ['year', year],
    ['doi', str(item.DOI)],
    ['url', str(item.url)],
  ];
  const body = all
    .filter(([, v]) => v)
    .map(([k, v]) => `  ${k.padEnd(12)} = {${v}}`)
    .join(',\n');
  return `@${type}{${key},\n${body}\n}`;
}
