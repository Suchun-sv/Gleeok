import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeLatex, makeCitationKey, toBibtex } from '../../shared/src/bibtex.ts';
import { confidentMatch, rankCandidates, recordFields, splitName, type SparqlResult } from '../../shared/src/dblp.ts';
import type { LibraryItem } from '../../shared/src/library.ts';

const item = (fields: Partial<LibraryItem>): LibraryItem => ({ key: 'ABCD2345', version: 1, itemType: 'conferencePaper', dateAdded: '', dateModified: '', ...fields });

const rows = (pairs: [string, string][]): SparqlResult => ({
  results: { bindings: pairs.map(([prop, val]) => ({ prop: { value: `https://dblp.org/rdf/schema#${prop}` }, val: { value: val } })) },
});

test('citation keys follow Google Scholar and never clash', () => {
  const paper = item({ title: 'Attention Is All You Need', date: '2017', creators: [{ creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' }] });
  assert.equal(makeCitationKey(paper, new Set()), 'vaswani2017attention');
  assert.equal(makeCitationKey(paper, new Set(['vaswani2017attention'])), 'vaswani2017attentiona');
  const stop = item({ title: 'On the Opportunities and Risks of Foundation Models', date: '2021', creators: [{ creatorType: 'author', lastName: 'Bommasani', firstName: 'R.' }] });
  assert.equal(makeCitationKey(stop, new Set()), 'bommasani2021opportunities');
  assert.equal(makeCitationKey(item({ title: 'Ünïcode', creators: [{ creatorType: 'author', lastName: 'Gödel' }] }), new Set()), 'godelunicode');
});

test('BibTeX escapes LaTeX and protects capitals', () => {
  assert.equal(escapeLatex('R&D 100% $x$ a_b #1'), 'R\\&D 100\\% \\$x\\$ a\\_b \\#1');
  const bib = toBibtex(
    item({
      title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
      creators: [
        { creatorType: 'author', firstName: 'Jacob', lastName: 'Devlin' },
        { creatorType: 'author', name: 'Google AI Language' },
      ],
      proceedingsTitle: 'Proceedings of NAACL-HLT 2019',
      pages: '4171-4186',
      date: '2019-06',
      DOI: '10.18653/V1/N19-1423',
      url: 'https://doi.org/10.18653/v1/N19-1423?x=a_b',
    }),
    'devlin2019bert',
  );
  assert.match(bib, /^@inproceedings\{devlin2019bert,/);
  assert.match(bib, /author\s+= \{Devlin, Jacob and \{Google AI Language\}\}/);
  assert.match(bib, /title\s+= \{\{BERT:\} Pre-training of Deep Bidirectional Transformers for Language Understanding\}/);
  assert.match(bib, /booktitle\s+= \{Proceedings of \{NAACL-HLT\} 2019\}|booktitle\s+= \{Proceedings of NAACL-HLT 2019\}/);
  assert.match(bib, /pages\s+= \{4171--4186\}/);
  assert.match(bib, /year\s+= \{2019\}/);
  // URLs and DOIs are not escaped.
  assert.match(bib, /url\s+= \{https:\/\/doi\.org\/10\.18653\/v1\/N19-1423\?x=a_b\}/);
});

test('arXiv preprints come out as DBLP writes them', () => {
  const bib = toBibtex(item({ itemType: 'preprint', title: 'LoRA: Low-Rank Adaptation of Large Language Models', archiveID: 'arXiv:2106.09685', date: '2021' }), 'hu2021lora');
  assert.match(bib, /^@article\{hu2021lora,/);
  assert.match(bib, /journal\s+= \{CoRR\}/);
  assert.match(bib, /volume\s+= \{abs\/2106\.09685\}/);
  assert.match(bib, /title\s+= \{\{LoRA:\} \{Low-Rank\} Adaptation of Large Language Models\}/);
});

test('DBLP names drop homonym numbers and keep particles with the last name', () => {
  assert.deepEqual(splitName('Wei Li 0001'), { creatorType: 'author', firstName: 'Wei', lastName: 'Li' });
  assert.deepEqual(splitName('Aidan N. Gomez'), { creatorType: 'author', firstName: 'Aidan N.', lastName: 'Gomez' });
  assert.deepEqual(splitName('Guido van Rossum'), { creatorType: 'author', firstName: 'Guido', lastName: 'van Rossum' });
});

test('candidates rank the exact title first, the published version before the preprint', () => {
  const found: SparqlResult = {
    results: {
      bindings: [
        { p: { value: 'https://dblp.org/rec/journals/corr/VaswaniSPUJGKP17' }, title: { value: 'Attention Is All You Need.' }, venue: { value: 'CoRR' }, year: { value: '2017' } },
        { p: { value: 'https://dblp.org/rec/conf/acl/KleinN19' }, title: { value: 'Attention Is (not) All You Need for Commonsense Reasoning.' }, venue: { value: 'ACL (1)' }, year: { value: '2019' } },
        { p: { value: 'https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17' }, title: { value: 'Attention is All you Need.' }, venue: { value: 'NIPS' }, year: { value: '2017' } },
      ],
    },
  };
  const ranked = rankCandidates('Attention is all you need', found);
  assert.deepEqual(
    ranked.map((c) => c.key),
    ['conf/nips/VaswaniSPUJGKP17', 'journals/corr/VaswaniSPUJGKP17', 'conf/acl/KleinN19'],
  );
  assert.equal(confidentMatch(ranked)?.key, 'conf/nips/VaswaniSPUJGKP17');
  assert.equal(confidentMatch(rankCandidates('Attention for commonsense', found)), undefined);
});

test('DBLP records map to Zotero fields', () => {
  const authors: SparqlResult = { results: { bindings: [{ name: { value: 'Ashish Vaswani' } }, { name: { value: 'Noam Shazeer' } }] } };
  const nips = recordFields(
    'conf/nips/VaswaniSPUJGKP17',
    rows([
      ['bibtexType', 'http://purl.org/net/nknouf/ns/bibtex#Inproceedings'],
      ['title', 'Attention is All you Need.'],
      ['yearOfPublication', '2017'],
      ['pagination', '5998-6008'],
      ['publishedIn', 'NIPS'],
      ['primaryDocumentPage', 'https://proceedings.neurips.cc/paper/2017/hash/x-Abstract.html'],
    ]),
    authors,
    rows([['title', 'Advances in Neural Information Processing Systems 30'], ['publishedBy', 'Curran']]),
  );
  assert.equal(nips.itemType, 'conferencePaper');
  assert.equal(nips.title, 'Attention is All you Need');
  assert.equal(nips.conferenceName, 'NIPS');
  assert.equal(nips.proceedingsTitle, 'Advances in Neural Information Processing Systems 30');
  assert.deepEqual((nips.creators as unknown[]).length, 2);

  const acl = recordFields(
    'conf/acl/KleinN19',
    rows([
      ['bibtexType', 'http://purl.org/net/nknouf/ns/bibtex#Inproceedings'],
      ['title', 'X.'],
      ['publishedIn', 'ACL (1)'],
      ['doi', 'https://doi.org/10.18653/V1/P19-1477'],
    ]),
    authors,
    rows([]),
  );
  assert.equal(acl.conferenceName, 'ACL');
  assert.equal(acl.DOI, '10.18653/V1/P19-1477');

  const corr = recordFields(
    'journals/corr/VaswaniSPUJGKP17',
    rows([
      ['bibtexType', 'http://purl.org/net/nknouf/ns/bibtex#Article'],
      ['title', 'Attention Is All You Need.'],
      ['publishedInJournal', 'CoRR'],
      ['publishedInJournalVolume', 'abs/1706.03762'],
    ]),
    authors,
    rows([]),
  );
  assert.equal(corr.itemType, 'preprint');
  assert.equal(corr.archiveID, 'arXiv:1706.03762');
  assert.equal(corr.url, 'https://arxiv.org/abs/1706.03762');

  const jmlr = recordFields(
    'journals/jmlr/RaffelSRLNMZLL20',
    rows([
      ['bibtexType', 'http://purl.org/net/nknouf/ns/bibtex#Article'],
      ['title', 'T5.'],
      ['publishedInJournal', 'J. Mach. Learn. Res.'],
      ['publishedInJournalVolume', '21'],
      ['pagination', '140:1-140:67'],
    ]),
    authors,
    rows([]),
  );
  assert.equal(jmlr.itemType, 'journalArticle');
  assert.equal(jmlr.publicationTitle, 'J. Mach. Learn. Res.');
  assert.equal(jmlr.volume, '21');
});
