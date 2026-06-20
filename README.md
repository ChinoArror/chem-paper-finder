# ChemPaper Finder

化学文献检索与合法开放 PDF 获取 WebApp。当前 MVP 支持 DOI、完整题录、作者/期刊/年份/关键词检索，接入 Auth Center、Cloudflare Workers、D1、R2 和 Queues。

## 已实现

- Crossref DOI/题录检索、OpenAlex 补充检索、Unpaywall 开放 PDF 判断。
- CORE 机构仓储候选接入：设置 `CORE_API_KEY` 后启用，候选标记为 repository / accepted manuscript。
- ChemRxiv 预印本候选接入：使用公开 API best-effort 查询，候选标记为 preprint。
- Auth Center Agent 用量限制已启用：OpenAlex / CORE 等无法计算 token 的外部 key API 按请求次数和频率限制，`tokens` 上报为 `0`；Gemini 可从 `usageMetadata.totalTokenCount` 提取 token 后上报。
- 查询任务进入 Cloudflare Queue，完成后写入历史记录。
- 开放 PDF 候选入库，记录来源、版本类型、license、评分和验证状态。
- 只从后端已记录候选下载 PDF，下载前校验响应类型和 `%PDF-` 文件头。
- 开放 PDF 与题录 PDF 保存到 R2 的 `users/{uuid}/...` 路径。
- 无开放 PDF 时自动生成题录 PDF；有开放 PDF 时按需生成题录 PDF。
- 历史列表、历史详情、删除记录、删除候选、删除已保存文件。
- 桌面端和移动端响应式界面。

## 暂未实现

- PMC / Europe PMC 深度接入。
- OCSR、结构式识别、SMILES、反应式识别、全文语义分析。
- 付费墙绕过、Sci-Hub、盗版镜像源，且不会实现。

## 本地开发

```bash
npm install
cp .env.example .dev.vars
npm run build
npx wrangler dev --port 8787
```

## 部署

```bash
npx wrangler d1 execute chem-paper-finder-db --remote --file migrations/0001_initial.sql
npm run build
npx wrangler deploy
```

生产配置在 `wrangler.jsonc` 中维护，敏感值放在 `.dev.vars` 并通过 Wrangler secret 上传。

## 用量限制

`wrangler.jsonc` 中 `ENABLE_QUOTA=true`。所有登录用户请求会先经过 Auth Center quota pre-check；外部 API key 调用会再次进行细粒度 pre-check。文献检索 API 无法可靠计算 token 时只参与 RPM/RPD，不扣每日 token 额度。

## Wrangler TOML 参考

项目实际使用 `wrangler.jsonc`。如果需要 TOML，可按下列绑定映射：

```toml
name = "chem-paper-finder"
main = "src/worker/index.ts"
compatibility_date = "2026-06-17"

[[d1_databases]]
binding = "DB"
database_name = "chem-paper-finder-db"
database_id = "d73d1020-8beb-4d64-ab73-55f4b1773a86"

[[r2_buckets]]
binding = "PAPER_BUCKET"
bucket_name = "chem-paper-finder-save"

[[queues.producers]]
binding = "LOOKUP_QUEUE"
queue = "chem-paper-finder-lookup"

[[queues.consumers]]
queue = "chem-paper-finder-lookup"
```

## 合规说明

系统只下载 Unpaywall / OpenAlex 等开放来源返回且后端已记录的 PDF 候选。所有下载会校验文件头，不允许前端提交任意 URL，不使用 Sci-Hub、镜像站或任何未授权全文来源。
