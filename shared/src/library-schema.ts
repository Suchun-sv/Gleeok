/**
 * The item types and fields the 文献库 offers, a subset of Zotero's schema (zotero-schema) with
 * Chinese labels. Field names are Zotero's, so items stay compatible; fields of other types
 * that an item already has are kept and shown under 其他字段.
 */

export const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  abstractNote: '摘要',
  publicationTitle: '期刊',
  proceedingsTitle: '论文集',
  conferenceName: '会议名称',
  bookTitle: '书名',
  websiteTitle: '网站',
  repository: '仓库',
  archiveID: '编号',
  university: '学校',
  institution: '机构',
  thesisType: '学位类型',
  reportNumber: '报告编号',
  reportType: '报告类型',
  websiteType: '网站类型',
  presentationType: '演讲类型',
  meetingName: '会议',
  volume: '卷',
  issue: '期',
  pages: '页码',
  numPages: '总页数',
  series: '丛书',
  edition: '版次',
  publisher: '出版社',
  place: '地点',
  date: '日期',
  journalAbbreviation: '期刊缩写',
  language: '语言',
  DOI: 'DOI',
  ISBN: 'ISBN',
  ISSN: 'ISSN',
  shortTitle: '短标题',
  url: '网址',
  accessDate: '访问日期',
  extra: '其他',
  citationKey: '引用键',
  dblpKey: 'DBLP',
};

export interface ItemTypeDef {
  type: string;
  label: string;
  /** In display order; `title` first. */
  fields: string[];
  creatorTypes: string[];
}

const tail = ['citationKey', 'language', 'shortTitle', 'url', 'accessDate', 'abstractNote', 'extra'];

export const ITEM_TYPES: ItemTypeDef[] = [
  {
    type: 'journalArticle',
    label: '期刊文章',
    fields: ['title', 'publicationTitle', 'volume', 'issue', 'pages', 'date', 'series', 'journalAbbreviation', 'DOI', 'ISSN', ...tail],
    creatorTypes: ['author', 'editor', 'contributor', 'translator'],
  },
  {
    type: 'conferencePaper',
    label: '会议论文',
    fields: ['title', 'conferenceName', 'proceedingsTitle', 'place', 'publisher', 'volume', 'pages', 'date', 'series', 'DOI', 'ISBN', ...tail],
    creatorTypes: ['author', 'editor', 'contributor', 'translator'],
  },
  {
    type: 'preprint',
    label: '预印本',
    fields: ['title', 'repository', 'archiveID', 'place', 'date', 'series', 'DOI', ...tail],
    creatorTypes: ['author', 'editor', 'contributor', 'translator'],
  },
  {
    type: 'book',
    label: '书',
    fields: ['title', 'series', 'volume', 'edition', 'place', 'publisher', 'date', 'numPages', 'ISBN', ...tail],
    creatorTypes: ['author', 'editor', 'contributor', 'translator'],
  },
  {
    type: 'bookSection',
    label: '书的章节',
    fields: ['title', 'bookTitle', 'series', 'volume', 'edition', 'place', 'publisher', 'date', 'pages', 'ISBN', ...tail],
    creatorTypes: ['author', 'editor', 'bookAuthor', 'contributor', 'translator'],
  },
  {
    type: 'thesis',
    label: '学位论文',
    fields: ['title', 'thesisType', 'university', 'place', 'date', 'numPages', ...tail],
    creatorTypes: ['author', 'contributor'],
  },
  {
    type: 'report',
    label: '报告',
    fields: ['title', 'reportNumber', 'reportType', 'institution', 'place', 'date', 'pages', 'series', ...tail],
    creatorTypes: ['author', 'editor', 'contributor', 'translator'],
  },
  {
    type: 'webpage',
    label: '网页',
    fields: ['title', 'websiteTitle', 'websiteType', 'date', ...tail],
    creatorTypes: ['author', 'contributor', 'translator'],
  },
  {
    type: 'presentation',
    label: '演讲',
    fields: ['title', 'presentationType', 'meetingName', 'place', 'date', ...tail],
    creatorTypes: ['presenter', 'contributor'],
  },
  {
    type: 'document',
    label: '文档',
    fields: ['title', 'publisher', 'date', ...tail],
    creatorTypes: ['author', 'editor', 'contributor', 'translator'],
  },
];

export const CREATOR_LABELS: Record<string, string> = {
  author: '作者',
  editor: '编辑',
  contributor: '贡献者',
  translator: '译者',
  bookAuthor: '书作者',
  presenter: '演讲者',
};

export const itemTypeDef = (type: string): ItemTypeDef =>
  ITEM_TYPES.find((t) => t.type === type) ?? { type, label: type, fields: ['title', ...tail], creatorTypes: ['author', 'contributor'] };

/** Where a regular item appeared, for the list's 期刊/会议 column. */
export const PUBLICATION_FIELDS = [
  // Short names first: "NeurIPS" reads better in a column than the proceedings' full title.
  'conferenceName',
  'journalAbbreviation',
  'publicationTitle',
  'proceedingsTitle',
  'repository',
  'bookTitle',
  'websiteTitle',
  'university',
  'institution',
  'meetingName',
  'publisher',
];

/** Reading status, a Gleeok field (Zotero has none): unset means unread. */
export const READ_STATUS_LABELS: Record<string, string> = { unread: '未读', reading: '在读', done: '读完' };
