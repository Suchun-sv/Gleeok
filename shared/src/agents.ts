/**
 * Agent connections: tokens the user hands to their own agents (Claude Code, Codex, a Paseo
 * workspace…) to manage the 日程 and the 文献库 through the REST API or MCP. Each token is
 * limited to its scopes and can be revoked; see docs/agents.md.
 */

export type AgentScope = 'planner' | 'library';
export const AGENT_SCOPES: { id: AgentScope; label: string }[] = [
  { id: 'planner', label: '日程' },
  { id: 'library', label: '文献库' },
];

/** Every agent token starts with this, so the server tells them from its own token at a glance. */
export const AGENT_TOKEN_PREFIX = 'gleeok_agent_';

export interface AgentInfo {
  id: string;
  /** Shown on what it creates ("由 邮件助手 创建"). */
  name: string;
  scopes: AgentScope[];
  createdAt: string;
  lastUsedAt?: string;
}

/** Creating a connection or a new token for it: the token is only ever shown here. */
export interface AgentCreated {
  agent: AgentInfo;
  token: string;
}

/** What to paste into an agent: the guide, and the MCP set-up for Claude Code and Codex. */
export interface AgentHandoff {
  url: string;
  guide: string;
  claude: string;
  codex: string;
}

export function agentHandoff(o: { url: string; token: string; name: string; scopes: AgentScope[]; timeZone: string }): AgentHandoff {
  const mcp = `${o.url}/mcp`;
  return {
    url: o.url,
    guide: agentGuide(o),
    claude: `claude mcp add --transport http gleeok ${mcp} --header "Authorization: Bearer ${o.token}"`,
    codex: `[mcp_servers.gleeok]\nurl = "${mcp}"\nhttp_headers = { Authorization = "Bearer ${o.token}" }`,
  };
}

/** The guide an agent reads: how to connect, the rules, the data, the calls. */
export function agentGuide(o: { url: string; token: string; name: string; scopes: AgentScope[]; timeZone: string }): string {
  const planner = o.scopes.includes('planner');
  const library = o.scopes.includes('library');
  const auth = `-H "Authorization: Bearer ${o.token}"`;
  const parts: string[] = [];
  parts.push(`# Gleeok：${[planner && '日程', library && '文献库'].filter(Boolean).join('和')}

你可以通过下面的接口管理用户在 Gleeok 里的${[planner && '日程（任务、时间块）', library && '文献库（Zotero 式的论文条目、分类、笔记、PDF、批注）'].filter(Boolean).join('和')}。
用户在桌面和手机上看到的就是这些数据，改动会在一分钟内同步过去。

## 连接

- 地址：${o.url}
- 令牌（这个连接叫「${o.name}」）：每个请求带上 \`Authorization: Bearer ${o.token}\`
- 用户的时区：${o.timeZone}。说「今天」「明天下午三点」时按这个时区算。
- 能用 MCP 就用 MCP：\`${o.url}/mcp\`（Streamable HTTP，同一个令牌），工具会替你处理版本号。
  Claude Code：\`claude mcp add --transport http gleeok ${o.url}/mcp --header "Authorization: Bearer ${o.token}"\`
- 不能用 MCP 时用下面的 REST 接口。最新版说明：\`curl ${auth} ${o.url}/api/agent/guide\`

## 规矩

- 改之前先读最新的数据；不要凭记忆里的旧版本去改。
- 删除一律放进回收站（设 \`deleted: true\`）；除非用户明确要求，不要用 DELETE 彻底删除。
- 你新建的东西会自动记上「由 ${o.name} 创建」，不用自己写。
- 做完告诉用户你改了什么（标题、日期），方便他核对。

## 版本号（REST）

每个对象都有 \`version\`。改一个对象（PATCH）时带上请求头 \`If-Unmodified-Since-Version: <它的 version>\`；
返回 409 表示别处刚改过，重新 GET 这个对象再改。PATCH 只改你给的字段，字段值为 \`null\` 表示删掉这个字段。`);

  if (planner) {
    parts.push(`## 日程

### 任务（tasks）

\`\`\`
key        8 位字符串，服务器生成
title      标题（必填）
notes      备注
due        截止："YYYY-MM-DD"，或带时间 "YYYY-MM-DDTHH:mm"（用户时区的本地时间）
priority   0 无、1 低、2 中、3 高
subtasks   [{ id, title, done }]，id 随便取一个不重复的短字符串
estimate   预估番茄数（一个番茄 25 分钟）
projectId  属于哪个 Gleeok 项目（没有就是收件箱），项目列表见 GET /api/agent/projects
done       已完成时为 true，同时设 doneAt（ISO 时间）；取消完成时两个都设 null
deleted    在回收站里时为 true
createdBy  谁创建的（服务器填）
\`\`\`

### 时间块（blocks）

日历上「这段时间做什么」，和任务完成与否无关。
\`\`\`
start, end  ISO 时间，带时区偏移，例如 "2026-10-24T15:00:00+01:00"
taskKey     对应的任务；或者不对应任务，只写 title（比如「午饭」）
\`\`\`

### 接口

\`\`\`
GET    /api/planner                       全部任务、时间块、番茄记录（?since=<version> 只取之后的变化）
GET    /api/planner/tasks/<key>           一个任务
POST   /api/planner/tasks                 新建（body 是一个对象或数组）
PATCH  /api/planner/tasks/<key>           修改（带 If-Unmodified-Since-Version）
POST   /api/planner/blocks                新建时间块
PATCH  /api/planner/blocks/<key>          修改时间块
DELETE /api/planner/blocks/<key>          删除时间块（时间块没有回收站）
GET    /api/agent/projects                Gleeok 项目（id、名字）
\`\`\`

\`\`\`sh
# 新建任务
curl -X POST ${o.url}/api/planner/tasks ${auth} -H "content-type: application/json" \\
  -d '{"title":"回复导师邮件","due":"2026-10-25T10:00","priority":3}'
# 勾选完成（version 用 GET 得到的）
curl -X PATCH ${o.url}/api/planner/tasks/<key> ${auth} -H "content-type: application/json" \\
  -H "If-Unmodified-Since-Version: <version>" -d '{"done":true,"doneAt":"2026-10-24T18:00:00Z"}'
\`\`\``);
  }

  if (library) {
    parts.push(`## 文献库

条目就是 Zotero 的条目 JSON（字段名和 Zotero 一样），key 是 8 位（字符集 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ）。

\`\`\`
items        itemType（journalArticle、conferencePaper、preprint、book、thesis、report、webpage…）、
             title、creators [{creatorType:"author", firstName, lastName}]、date、publicationTitle、
             proceedingsTitle、DOI、url、abstractNote、tags [{tag}]、collections [分类 key]、
             citationKey、deleted、readStatus（"unread" | "reading" | "read"）
             笔记：itemType "note"，note（HTML），parentItem 指向条目
             附件：itemType "attachment"，parentItem 指向条目，文件在 /api/library/items/<key>/file
collections  name、parentCollection（上级分类 key，或 false）
annotations  PDF 批注（属于附件）：type、text（选中的原文）、comment、color、pageLabel
\`\`\`

### 接口

\`\`\`
GET    /api/library                        全部条目、分类、批注（?since=<version> 只取变化）
GET    /api/library/items/<key>            一个条目
POST   /api/library/items                  新建条目（或笔记、附件）
PATCH  /api/library/items/<key>            修改（带 If-Unmodified-Since-Version）
POST   /api/library/collections            新建分类
GET    /api/library/items/<key>/file       下载附件文件
PUT    /api/library/items/<key>/file       上传附件文件（先建 attachment 条目，body 是 PDF 字节）
\`\`\`

\`\`\`sh
curl -X POST ${o.url}/api/library/items ${auth} -H "content-type: application/json" \\
  -d '{"itemType":"preprint","title":"Attention Is All You Need","creators":[{"creatorType":"author","firstName":"Ashish","lastName":"Vaswani"}],"date":"2017","url":"https://arxiv.org/abs/1706.03762"}'
\`\`\`

MCP 的 \`library_create_item\` / \`library_attach_pdf\` 可以直接给 PDF 的网址（arXiv 的 abs 页也行），服务器会下载并挂上去。`);
  }
  return `${parts.join('\n\n')}\n`;
}
