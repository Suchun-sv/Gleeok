# Agent 连接

让用户自己的 agent（Claude Code、Codex、Paseo workspace 里的助手……）管理日程和文献库。2026-10-24 完成。

## 已定的决定

| 问题 | 决定 |
| --- | --- |
| 接法 | 两种都有：REST（贴一段 Markdown 说明给 agent）和 MCP（`/mcp`，Streamable HTTP） |
| 令牌 | 每个连接一个 agent 令牌（`gleeok_agent_…`），不用服务器主令牌；可以换新、吊销；服务器只存 SHA-256 |
| 范围 | 每个连接选「日程」和 / 或「文献库」；碰不到项目、标签页同步、密码库、翻译设置、连接管理 |
| 权限 | 能新建、修改、勾选完成、放进回收站；说明里要求不彻底删除（时间块没有回收站，可以删） |
| 来源 | agent 新建的任务、时间块、条目、笔记、分类带 `createdBy`（连接的名字），界面上显示小机器人图标 / 「由 X 创建」 |
| 本地模式 | Gleeok 开一个端口（默认 127.0.0.1:7421，`GLEEOK_AGENT_PORT`），只认 agent 令牌，只在有连接、Gleeok 开着时监听；可以选择允许其他电脑连接（监听所有网卡，地址优先用 tailnet 的） |

## 入口

设置 → Agent：
- 新建连接：名字 + 范围 → 出现一个只显示一次的框，三个按钮：
  - **复制说明（Markdown）**：地址、令牌、时区、规矩、数据格式、REST 接口和 curl 示例（`shared/src/agents.ts` 的 `agentGuide`），直接贴给 agent 或存成它的 skill / CLAUDE.md
  - **复制 Claude Code 命令**：`claude mcp add --transport http gleeok <url>/mcp --header "Authorization: Bearer <令牌>"`
  - **复制 Codex 配置**：`[mcp_servers.gleeok]` 加 `url` 和 `http_headers`，追加到 `~/.codex/config.toml`（没在 Codex 上实测）
- 连接列表：名字、范围、最后使用时间（最多每分钟记一次）、换新令牌、吊销。
- 日程（日历标题栏）和文献库（工具栏）各有一个机器人按钮：弹出同样的连接面板，范围默认勾选所在的那一块，
  底下有「在设置里管理全部连接」。
- 服务器模式下 agent 用的地址是这台电脑连同步服务器的地址（client.json 的 serverUrl）；本地模式见「本机接口」卡片。

## 后端

- `server/src/agents.ts`：`Agents`（表 `agents` 在 gleeok.db 里，备份自然带上）、`agentMayUse`（范围 → 路径）、
  `agentRoutes`（`/api/agents`：列表、新建、换令牌、吊销，只有主令牌能用）。
- `server/src/app.ts` 的认证中间件：`gleeok_agent_` 开头的按连接和范围放行，并记下是哪个连接；其他请求照旧比对主令牌。
  本地模式进程内调用没有令牌，所以本机端口（`app/src/main/agent-port.ts`）在进门前就拒绝非 agent 令牌。
- 给 agent 的只读接口：`GET /api/agent/guide`（Markdown 说明，令牌位置留空）、`GET /api/agent/projects`（项目 id 和名字，日程范围）。
- REST 新建时 `byAgent()` 给对象加 `createdBy`（日程和文献库的 POST）。
- `server/src/mcp.ts`：无状态 JSON-RPC（initialize、ping、tools/list、tools/call，支持批量；通知回 202；GET 回 405）。
  工具直接调用存储，版本号由服务器处理（冲突时重读重试），所以 agent 不用管。

### MCP 工具

日程：`planner_list_tasks`（状态、截止日期范围、项目、关键字；附当前时间和时区）、`planner_get_task`（含时间块）、
`planner_create_task`、`planner_update_task`（`done` 勾选 / 取消；子任务整体替换）、`planner_trash_task`、
`planner_list_blocks`、`planner_create_block`、`planner_update_block`、`planner_delete_block`、`planner_list_projects`。

文献库：`library_search`（标题、作者、年份、期刊 / 会议、DOI、摘要、标签、引用键；分类、标签、类型筛选）、
`library_get_item`（字段、笔记、附件、批注数）、`library_get_annotations`（高亮原文和评论，按页序）、
`library_list_collections`、`library_create_item`（可带 `pdf_url`：服务器下载 PDF 挂上去，arXiv abs 页自动换成 PDF）、
`library_update_item`（字段、作者、标签 / 分类的替换或增减、阅读状态）、`library_add_note`（纯文本转 HTML 段落）、
`library_create_collection`、`library_trash_item`、`library_attach_pdf`。

## 测试

- `server/test/agents.test.ts`：令牌范围和吊销、REST 来源标记、MCP 握手、按范围列工具、日程和文献库工具（含下载 PDF）。
- `dev/agents.json`：本地模式下建连接、打开本机端口、界面截图；配合脚本用 curl 从外面打 REST 和 MCP。
