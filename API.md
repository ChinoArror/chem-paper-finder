# API 文档

所有 `/api/*` 接口除 `/api/config`、`/api/health`、`/api/sso-callback`、`/api/track` 外都需要 Auth Center Bearer token。

## 查询

- `POST /api/papers/lookup`
  - body: `{ "input": "...", "mode": "auto|doi|citation|fuzzy" }`
  - 返回队列任务：`{ queued, taskId, status }`

- `GET /api/tasks/:id`
  - 查询队列任务状态和结果。

## 文献与 PDF

- `GET /api/papers/:id`
  - 返回文献、PDF 候选、当前用户已保存文件。

- `POST /api/papers/:id/oa-check`
  - 从 Unpaywall / OpenAlex / CORE / ChemRxiv 收集并入库开放 PDF 候选。
  - CORE 需要 `CORE_API_KEY`；ChemRxiv 为公开 API best-effort 查询。
  - OpenAlex / CORE 这类无法计算 token 的 key API 会按请求次数/频率走 Auth Center quota，消费上报 `tokens: 0`。

- `POST /api/papers/:id/download-open-pdf`
  - body: `{ "candidateId": "..." }`
  - 后端从 D1 候选读取 URL，校验并保存到 R2。

- `POST /api/papers/:id/export-citation-pdf`
  - 生成题录 PDF 并保存到 R2。

- `GET /api/files?key=...`
  - 带鉴权下载当前用户目录下的 R2 文件。

- `DELETE /api/files`
  - body: `{ "key": "users/{uuid}/..." }`
  - 删除当前用户自己的 R2 文件和 D1 文件记录。

## 历史

- `GET /api/history`
- `GET /api/history/:id`
- `DELETE /api/history/:id`
- `DELETE /api/history/:id/candidates/:candidateId`

## 批量

- `POST /api/batch/lookup`
- `POST /api/batch/export`

## 数据表

核心表包括 `papers`、`paper_pdf_candidates`、`paper_files`、`search_tasks`、`paper_downloads`、`citation_exports`、`users`。
