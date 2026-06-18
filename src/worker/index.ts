import { Hono } from "hono";
import { z } from "zod";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { zipSync } from "fflate";

type Bindings = Env;

type UserProfile = {
  uuid: string;
  user_id?: number;
  name?: string;
  username?: string;
  email?: string;
  role?: string;
  avatar_url?: string;
};

type OpenPdfInfo = {
  pdfUrl: string;
  landingUrl?: string;
  license?: string;
  hostType?: string;
  version?: string;
  oaStatus?: string;
};

type PaperCandidate = {
  id: string;
  doi?: string;
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  publisherUrl?: string;
  source: "Crossref" | "OpenAlex";
  confidence: number;
  matchReason: string;
  isOa: boolean;
  oaStatus?: string;
  license?: string;
  pdfUrl?: string;
  pdfHostType?: string;
  openPdfR2Key?: string;
  openPdfDownloadUrl?: string;
  citationPdfR2Key?: string;
  citationPdfDownloadUrl?: string;
};

type LookupQueueMessage = {
  taskId: string;
  userId: string;
  input: string;
  inputType: string;
};

const lookupSchema = z.object({
  input: z.string().min(1, "请输入 DOI、题录或作者/期刊/年份/关键词"),
  mode: z.enum(["auto", "doi", "citation", "fuzzy", "batch"]).default("auto")
});

const doiSchema = z.object({
  doi: z.string().min(1)
});

const paperIdSchema = z.object({
  paperId: z.string().min(1)
});

const batchSchema = z.object({
  input: z.string().min(1),
  mode: z.enum(["auto", "citation", "fuzzy"]).default("auto")
});

const app = new Hono<{ Bindings: Bindings; Variables: { user: UserProfile; token: string } }>();

app.get("/api/config", (c) => {
  return c.json({
    appId: c.env.APP_ID,
    authCenterUrl: c.env.AUTH_CENTER_URL,
    callbackPath: "/sso-callback"
  });
});

app.get("/api/health", (c) => c.json({ ok: true, app: c.env.APP_ID }));

app.post("/api/sso-callback", async (c) => {
  await ensureSchema(c.env.DB);

  let token = "";
  try {
    const body = await c.req.json<{ token?: string }>();
    token = body.token?.trim() ?? "";
  } catch {
    return c.json({ success: false, message: "无效的登录回调请求" }, 400);
  }

  if (!token) {
    return c.json({ success: false, message: "登录回调缺少 token" }, 400);
  }

  const payload = decodeJwtPayload(token);
  if (!payload?.uuid) {
    return c.json({ success: false, message: "登录 token 格式无效" }, 401);
  }
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    return c.json({ success: false, message: "登录已过期，请重新登录" }, 401);
  }

  const verify = await verifyWithAuthCenter(c.env, token);
  if (!verify.ok) {
    return c.json({ success: false, message: verify.message }, verify.status);
  }

  const user = normalizeUser(verify.user ?? payload);
  await upsertUser(c.env.DB, user);
  c.executionCtx.waitUntil(trackEvent(c.env, user.uuid, "login"));

  return c.json({ success: true, user, token });
});

app.post("/api/signout", async (c) => {
  const authUrl = trimSlash(c.env.AUTH_CENTER_URL);
  c.executionCtx.waitUntil(
    fetch(`${authUrl}/api/logout`, {
      method: "POST",
      headers: { Cookie: c.req.header("Cookie") ?? "" }
    }).catch(() => undefined)
  );
  return c.json({ success: true });
});

app.post("/api/track", async (c) => {
  const body = await c.req.json<{ event_type?: string; duration_seconds?: number; uuid?: string }>().catch(() => ({} as { event_type?: string; duration_seconds?: number; uuid?: string }));
  const uuid = body.uuid || c.req.header("x-user-uuid") || "";
  if (!uuid || !body.event_type) return c.json({ success: false }, 400);
  c.executionCtx.waitUntil(trackEvent(c.env, uuid, body.event_type, body.duration_seconds));
  return c.json({ success: true });
});

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/config" || c.req.path === "/api/health" || c.req.path === "/api/sso-callback" || c.req.path === "/api/signout" || c.req.path === "/api/track") {
    return next();
  }

  const token = readBearer(c.req.header("Authorization"));
  if (!token) return c.json({ success: false, message: "请先登录 ChemPaper Finder" }, 401);

  const verify = await verifyWithAuthCenter(c.env, token);
  if (!verify.ok) return c.json({ success: false, message: verify.message }, verify.status);

  const user = normalizeUser(verify.user ?? decodeJwtPayload(token));
  if (!user.uuid) return c.json({ success: false, message: "登录信息缺少用户 ID" }, 401);

  await ensureSchema(c.env.DB);
  await upsertUser(c.env.DB, user);
  c.set("user", user);
  c.set("token", token);
  return next();
});

app.post("/api/papers/lookup", async (c) => {
  const quota = await checkQuota(c.env, c.get("user").uuid);
  if (!quota.ok) return c.json({ success: false, message: quota.message }, quota.status);

  const parsed = lookupSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, message: parsed.error.issues[0]?.message ?? "输入无效" }, 400);

  const { input, mode } = parsed.data;
  const type = detectInputType(input, mode);
  if (type === "doi" && !extractDoi(input)) {
    return c.json({ success: false, message: "DOI 格式不正确，请检查 10.xxxx/xxxxx 这类格式" }, 400);
  }

  try {
    const taskId = makeShortId();
    await c.env.DB.prepare("INSERT INTO search_tasks (id, user_id, input_text, input_type, status, result_json) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(taskId, c.get("user").uuid, input, type, "queued", JSON.stringify({ candidates: [] }))
      .run();
    await c.env.LOOKUP_QUEUE.send({ taskId, userId: c.get("user").uuid, input, inputType: type });
    return c.json({ success: true, queued: true, taskId, status: "queued", inputType: type, candidates: [], quota: quota.data }, 202);
  } catch (error) {
    return c.json({ success: false, message: `任务提交失败：${toUserMessage(error)}` }, 502);
  }
});

app.post("/api/papers/oa-check", async (c) => {
  const parsed = doiSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, message: "请提供 DOI" }, 400);
  const doi = extractDoi(parsed.data.doi);
  if (!doi) return c.json({ success: false, message: "DOI 格式不正确" }, 400);

  const upw = await unpaywallByDoi(doi, c.env);
  const openPdf = extractOpenPdf(upw);
  return c.json({
    success: true,
    doi,
    isOa: upw?.is_oa === true,
    oaStatus: upw?.oa_status,
    openPdf
  });
});

app.post("/api/papers/download-open-pdf", async (c) => {
  const quota = await checkQuota(c.env, c.get("user").uuid);
  if (!quota.ok) return c.json({ success: false, message: quota.message }, quota.status);

  const body = await c.req.json().catch(() => ({}));
  const parsed = z.union([doiSchema, paperIdSchema]).safeParse(body);
  if (!parsed.success) return c.json({ success: false, message: "请提供 DOI 或 paperId" }, 400);

  const paper = "paperId" in parsed.data
    ? await getPaper(c.env.DB, parsed.data.paperId)
    : await getPaperByDoi(c.env.DB, extractDoi(parsed.data.doi) ?? "");
  const paperDoi = extractString(paper?.doi);
  const paperId = extractString(paper?.id);
  const doi = "doi" in parsed.data ? extractDoi(parsed.data.doi) : paperDoi;
  if (!doi) return c.json({ success: false, message: "该文献缺少有效 DOI，无法自动下载开放 PDF" }, 400);

  try {
    const result = await downloadVerifiedOpenPdf(c.env, paperId ?? stableId(doi), doi, c.get("user").uuid);
    c.executionCtx.waitUntil(consumeQuota(c.env, c.get("user").uuid, 1));
    return c.json({
      success: true,
      message: "已保存合法开放 PDF",
      ...result,
      downloadUrl: `/api/files?key=${encodeURIComponent(result.r2Key)}`
    });
  } catch (error) {
    return c.json({ success: false, message: toUserMessage(error) }, 409);
  }
});

app.post("/api/papers/export-citation-pdf", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.union([doiSchema, paperIdSchema]).safeParse(body);
  if (!parsed.success) return c.json({ success: false, message: "请提供 DOI 或 paperId" }, 400);

  const paper = "paperId" in parsed.data
    ? await getPaper(c.env.DB, parsed.data.paperId)
    : await getPaperByDoi(c.env.DB, extractDoi(parsed.data.doi) ?? "");
  if (!paper) return c.json({ success: false, message: "未找到这篇文献的本地记录，请先检索确认" }, 404);

  const existing = await c.env.DB.prepare("SELECT r2_key FROM citation_exports WHERE paper_id = ? AND user_id = ? ORDER BY datetime(created_at) DESC LIMIT 1")
    .bind(paper.id, c.get("user").uuid)
    .first<Record<string, unknown>>();
  const existingKey = extractString(existing?.r2_key);
  if (existingKey && await c.env.PAPER_BUCKET.head(existingKey)) {
    return c.json({
      success: true,
      r2Key: existingKey,
      downloadUrl: `/api/files?key=${encodeURIComponent(existingKey)}`
    });
  }

  const result = await saveCitationPdf(c.env, toCandidateFromRow(paper), c.get("user").uuid, "未找到合法开放全文 PDF 时，仅导出题录信息。");

  return c.json({
    success: true,
    ...result,
    downloadUrl: `/api/files?key=${encodeURIComponent(result.r2Key)}`
  });
});

app.post("/api/batch/lookup", async (c) => {
  const quota = await checkQuota(c.env, c.get("user").uuid);
  if (!quota.ok) return c.json({ success: false, message: quota.message }, quota.status);

  const parsed = batchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, message: parsed.error.issues[0]?.message ?? "批量输入无效" }, 400);

  const lines = parsed.data.input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 20);
  if (lines.length === 0) return c.json({ success: false, message: "请每行输入一条参考文献" }, 400);

  const taskId = makeShortId();
  await c.env.DB.prepare("INSERT INTO search_tasks (id, user_id, input_text, input_type, status, result_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(taskId, c.get("user").uuid, parsed.data.input, "batch", "running", JSON.stringify([]))
    .run();

  const items = [];
  for (const line of lines) {
    try {
      const type = detectInputType(line, parsed.data.mode);
      const candidates = await lookupCandidates(line, type, c.env);
      await Promise.all(candidates.map((candidate) => upsertPaper(c.env.DB, candidate)));
      items.push({
        input: line,
        status: candidates.length > 1 ? "multiple_candidates" : candidates.length === 1 ? "matched" : "not_found",
        candidates
      });
    } catch (error) {
      items.push({ input: line, status: "failed", message: toUserMessage(error), candidates: [] });
    }
  }

  await c.env.DB.prepare("UPDATE search_tasks SET status = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind("completed", JSON.stringify(items), taskId)
    .run();
  c.executionCtx.waitUntil(consumeQuota(c.env, c.get("user").uuid, Math.max(1, lines.length)));

  return c.json({ success: true, taskId, items });
});

app.get("/api/tasks/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM search_tasks WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("user").uuid)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ success: false, message: "未找到批量任务" }, 404);
  return c.json({ success: true, task: { ...row, result: parseJson(row.result_json, []) } });
});

app.get("/api/history", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, input_text, input_type, status, result_json, created_at, updated_at FROM search_tasks WHERE user_id = ? ORDER BY datetime(created_at) DESC")
    .bind(c.get("user").uuid)
    .all<Record<string, unknown>>();
  const items = (rows.results ?? []).map((row) => {
    const normalized = normalizeTaskResult(row.result_json);
    return {
      id: String(row.id),
      inputText: extractString(row.input_text) ?? "",
      inputType: extractString(row.input_type) ?? "auto",
      status: extractString(row.status) ?? "unknown",
      createdAt: extractString(row.created_at),
      updatedAt: extractString(row.updated_at),
      summary: buildTaskSummary(row, normalized),
      candidateCount: normalized.candidates.length,
      candidates: normalized.candidates.slice(0, 3)
    };
  });
  return c.json({ success: true, items });
});

app.get("/api/history/:id", async (c) => {
  const row = await getUserTask(c.env.DB, c.req.param("id"), c.get("user").uuid);
  if (!row) return c.json({ success: false, message: "未找到查询记录" }, 404);
  const normalized = normalizeTaskResult(row.result_json);
  const candidates = await enrichCandidatesWithStoredFiles(c.env.DB, normalized.candidates, c.get("user").uuid);
  return c.json({
    success: true,
    record: {
      id: String(row.id),
      inputText: extractString(row.input_text) ?? "",
      inputType: extractString(row.input_type) ?? "auto",
      status: extractString(row.status) ?? "unknown",
      createdAt: extractString(row.created_at),
      updatedAt: extractString(row.updated_at),
      summary: buildTaskSummary(row, { ...normalized, candidates }),
      candidates
    }
  });
});

app.delete("/api/history/:id", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM search_tasks WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("user").uuid)
    .run();
  if (!result.meta.changes) return c.json({ success: false, message: "未找到查询记录" }, 404);
  return c.json({ success: true });
});

app.delete("/api/history/:id/candidates/:candidateId", async (c) => {
  const row = await getUserTask(c.env.DB, c.req.param("id"), c.get("user").uuid);
  if (!row) return c.json({ success: false, message: "未找到查询记录" }, 404);
  const normalized = normalizeTaskResult(row.result_json);
  const nextCandidates = normalized.candidates.filter((candidate) => candidate.id !== c.req.param("candidateId"));
  if (nextCandidates.length === normalized.candidates.length) {
    return c.json({ success: false, message: "未找到该相似结果" }, 404);
  }
  const nextResultJson = normalized.rawArray
    ? JSON.stringify(normalized.rawArray.map((item) => {
      const row = item as { candidates?: PaperCandidate[] };
      return {
        ...row,
        candidates: Array.isArray(row.candidates)
          ? row.candidates.filter((candidate) => candidate.id !== c.req.param("candidateId"))
          : row.candidates
      };
    }))
    : JSON.stringify({ ...normalized.rawObject, inputType: normalized.inputType, candidates: nextCandidates });
  await c.env.DB.prepare("UPDATE search_tasks SET result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
    .bind(nextResultJson, c.req.param("id"), c.get("user").uuid)
    .run();
  return c.json({ success: true, candidates: nextCandidates });
});

app.get("/api/papers/:id", async (c) => {
  const paper = await getPaper(c.env.DB, c.req.param("id"));
  if (!paper) return c.json({ success: false, message: "未找到文献" }, 404);
  return c.json({ success: true, paper: toCandidateFromRow(paper), raw: paper });
});

app.post("/api/batch/export", async (c) => {
  const body = await c.req.json<{ taskId?: string; format?: "csv" | "bibtex" | "citation-zip" }>().catch(() => ({} as { taskId?: string; format?: "csv" | "bibtex" | "citation-zip" }));
  if (!body.taskId || !body.format) return c.json({ success: false, message: "缺少 taskId 或导出格式" }, 400);

  const task = await c.env.DB.prepare("SELECT * FROM search_tasks WHERE id = ? AND user_id = ?")
    .bind(body.taskId, c.get("user").uuid)
    .first<Record<string, unknown>>();
  if (!task) return c.json({ success: false, message: "未找到批量任务" }, 404);

  const items = parseJson(task.result_json, []) as Array<{ candidates?: PaperCandidate[] }>;
  const papers = items.flatMap((item) => item.candidates?.slice(0, 1) ?? []);
  if (body.format === "csv") {
    const csv = buildCsv(papers);
    return new Response(csv, {
      headers: downloadHeaders("chem-paper-finder.csv", "text/csv; charset=utf-8")
    });
  }
  if (body.format === "bibtex") {
    const bib = papers.map(buildBibTeX).join("\n\n");
    return new Response(bib, {
      headers: downloadHeaders("chem-paper-finder.bib", "application/x-bibtex; charset=utf-8")
    });
  }

  const files: Record<string, Uint8Array> = {};
  for (const paper of papers) {
    const pdf = await buildCitationPdf(paper, "Batch citation export. Legal open PDF availability is shown below.");
    const filename = `${safeFilename(paper.doi || paper.id)}.pdf`;
    files[filename] = new Uint8Array(pdf);
  }
  const zipped = zipSync(files);
  const key = `users/${c.get("user").uuid}/batch/${body.taskId}/citation-pdfs.zip`;
  await c.env.PAPER_BUCKET.put(key, zipped, { httpMetadata: { contentType: "application/zip" } });
  return c.json({ success: true, r2Key: key, downloadUrl: `/api/files?key=${encodeURIComponent(key)}` });
});

app.get("/api/files", async (c) => {
  const key = c.req.query("key");
  if (!key || key.includes("..")) return c.json({ success: false, message: "文件 key 无效" }, 400);
  const userPrefix = `users/${c.get("user").uuid}/`;
  if (key.startsWith("users/") && !key.startsWith(userPrefix)) {
    return c.json({ success: false, message: "无权访问该文件" }, 403);
  }

  const object = await c.env.PAPER_BUCKET.get(key);
  if (!object) return c.json({ success: false, message: "文件不存在或已过期" }, 404);

  const filename = key.split("/").at(-1) || "download";
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "no-store"
    }
  });
});

app.delete("/api/files", async (c) => {
  const body = await c.req.json<{ key?: string }>().catch(() => ({} as { key?: string }));
  const key = extractString(body.key) || c.req.query("key");
  if (!key || key.includes("..")) return c.json({ success: false, message: "文件 key 无效" }, 400);

  const userPrefix = `users/${c.get("user").uuid}/`;
  if (!key.startsWith(userPrefix)) {
    return c.json({ success: false, message: "无权删除该文件" }, 403);
  }

  await c.env.PAPER_BUCKET.delete(key);
  await c.env.DB.prepare("DELETE FROM paper_downloads WHERE user_id = ? AND r2_key = ?")
    .bind(c.get("user").uuid, key)
    .run();
  await c.env.DB.prepare("DELETE FROM citation_exports WHERE user_id = ? AND r2_key = ?")
    .bind(c.get("user").uuid, key)
    .run();
  await c.env.DB.prepare("UPDATE papers SET r2_pdf_key = NULL WHERE r2_pdf_key = ?")
    .bind(key)
    .run();

  return c.json({ success: true });
});

app.notFound(async (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async queue(batch, env) {
    await Promise.all(batch.messages.map((message) => processLookupQueueMessage(env, message)));
  }
} satisfies ExportedHandler<Bindings, LookupQueueMessage>;

async function processLookupQueueMessage(env: Bindings, message: Message<LookupQueueMessage>) {
  const { taskId, userId, input, inputType } = message.body;
  try {
    await ensureSchema(env.DB);
    await env.DB.prepare("UPDATE search_tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind("running", taskId)
      .run();
    const candidates = await lookupCandidates(input, inputType, env);
    await Promise.all(candidates.map((candidate) => upsertPaper(env.DB, candidate)));
    const archivedCandidates = await archiveFilesForCandidates(env, userId, candidates);
    await env.DB.prepare("UPDATE search_tasks SET status = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind("completed", JSON.stringify({ inputType, candidates: archivedCandidates }), taskId)
      .run();
    await consumeQuota(env, userId, 1);
    message.ack();
  } catch (error) {
    await env.DB.prepare("UPDATE search_tasks SET status = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind("failed", JSON.stringify({ inputType, candidates: [], message: toUserMessage(error) }), taskId)
      .run();
    message.ack();
  }
}

async function ensureSchema(db: D1Database) {
  const statements = [
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, user_id INTEGER, name TEXT, username TEXT, email TEXT, role TEXT, avatar_url TEXT, first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS papers (id TEXT PRIMARY KEY, doi TEXT UNIQUE, title TEXT, journal TEXT, year INTEGER, volume TEXT, issue TEXT, pages TEXT, authors_json TEXT, publisher TEXT, publisher_url TEXT, crossref_json TEXT, openalex_json TEXT, unpaywall_json TEXT, is_oa INTEGER DEFAULT 0, oa_status TEXT, license TEXT, pdf_url TEXT, r2_pdf_key TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS search_tasks (id TEXT PRIMARY KEY, user_id TEXT, input_text TEXT NOT NULL, input_type TEXT, status TEXT DEFAULT 'pending', result_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS paper_downloads (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, user_id TEXT, source_url TEXT, r2_key TEXT, license TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS citation_exports (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, user_id TEXT, format TEXT, r2_key TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
  ];
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

function readBearer(value?: string) {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

async function verifyWithAuthCenter(env: Bindings, token: string): Promise<{ ok: true; user?: unknown } | { ok: false; status: 401 | 403 | 500; message: string }> {
  try {
    const url = `${trimSlash(env.AUTH_CENTER_URL)}/api/verify?app_id=${encodeURIComponent(env.APP_ID)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      const body = await res.json<{ error?: string; message?: string }>().catch(() => ({} as { error?: string; message?: string }));
      return {
        ok: false,
        status: res.status === 403 ? 403 : 401,
        message: body.error || body.message || "Auth Center 验证失败，请重新登录"
      };
    }
    const data = await res.json<{ user?: unknown }>().catch(() => ({} as { user?: unknown }));
    return { ok: true, user: data.user ?? data };
  } catch (error) {
    return { ok: false, status: 500, message: `Auth Center 暂时不可用：${toUserMessage(error)}` };
  }
}

async function checkQuota(env: Bindings, uuid: string): Promise<{ ok: true; data?: unknown } | { ok: false; status: 401 | 403 | 429 | 500; message: string }> {
  if (String(env.ENABLE_QUOTA) !== "true" || !env.APP_SECRET) return { ok: true };
  try {
    const url = `${trimSlash(env.AUTH_CENTER_URL)}/api/quota/check?uuid=${encodeURIComponent(uuid)}&app_id=${encodeURIComponent(env.APP_ID)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.APP_SECRET}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      const body = await res.json<{ error?: string; message?: string }>().catch(() => ({} as { error?: string; message?: string }));
      const status = res.status === 429 ? 429 : res.status === 403 ? 403 : res.status === 401 ? 401 : 500;
      return { ok: false, status, message: body.error || body.message || "用量权限校验失败" };
    }
    return { ok: true, data: await res.json().catch(() => ({})) };
  } catch (error) {
    return { ok: false, status: 500, message: `用量校验失败：${toUserMessage(error)}` };
  }
}

async function consumeQuota(env: Bindings, uuid: string, tokens: number) {
  if (String(env.ENABLE_QUOTA) !== "true" || !env.APP_SECRET) return;
  await fetch(`${trimSlash(env.AUTH_CENTER_URL)}/api/quota/consume`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.APP_SECRET}`
    },
    body: JSON.stringify({ uuid, app_id: env.APP_ID, tokens })
  }).catch(() => undefined);
}

async function trackEvent(env: Bindings, uuid: string, eventType: string, durationSeconds?: number) {
  await fetch(`${trimSlash(env.AUTH_CENTER_URL)}/api/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: env.APP_ID,
      uuid,
      event_type: eventType,
      duration_seconds: durationSeconds
    })
  }).catch(() => undefined);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function normalizeUser(input: unknown): UserProfile {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    uuid: String(obj.uuid ?? ""),
    user_id: typeof obj.user_id === "number" ? obj.user_id : undefined,
    name: typeof obj.name === "string" ? obj.name : undefined,
    username: typeof obj.username === "string" ? obj.username : undefined,
    email: typeof obj.email === "string" ? obj.email : undefined,
    role: typeof obj.role === "string" ? obj.role : undefined,
    avatar_url: typeof obj.avatar_url === "string" ? obj.avatar_url : undefined
  };
}

async function upsertUser(db: D1Database, user: UserProfile) {
  await db.prepare(
    "INSERT INTO users (uuid, user_id, name, username, email, role, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(uuid) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, username = excluded.username, email = excluded.email, role = excluded.role, avatar_url = excluded.avatar_url, last_seen = CURRENT_TIMESTAMP"
  )
    .bind(user.uuid, user.user_id ?? null, user.name ?? null, user.username ?? null, user.email ?? null, user.role ?? null, user.avatar_url ?? null)
    .run();
}

function detectInputType(input: string, mode: string) {
  if (mode === "doi") return "doi";
  if (mode === "batch") return "batch";
  if (mode === "citation") return "citation";
  if (mode === "fuzzy") return "fuzzy";
  return extractDoi(input) ? "doi" : input.split(/\r?\n/).filter(Boolean).length > 1 ? "batch" : "citation";
}

function extractDoi(input: string) {
  const cleaned = input.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  const match = cleaned.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match?.[0]?.replace(/[.,;)\]]+$/, "").toLowerCase();
}

async function lookupCandidates(input: string, type: string, env: Bindings) {
  if (type === "doi") {
    const doi = extractDoi(input);
    if (!doi) throw new Error("DOI 格式不正确");
    const [crossref, openalex, upw] = await Promise.all([
      crossrefByDoi(doi, env),
      openAlexByDoi(doi, env).catch(() => null),
      unpaywallByDoi(doi, env)
    ]);
    return [toCrossrefCandidate(crossref, 1, "DOI 精确匹配", upw, openalex)];
  }

  const crossrefItems = await crossrefBibliographic(input, env).catch(() => []);
  let candidates = await Promise.all(
    crossrefItems.slice(0, 5).map(async (item: Record<string, unknown>) => {
      const doi = extractString(item.DOI);
      const upw = doi ? await unpaywallByDoi(doi, env).catch(() => null) : null;
      const score = typeof item.score === "number" ? Math.min(0.92, Math.max(0.55, item.score / 120)) : 0.72;
      return toCrossrefCandidate(item, score, score >= 0.9 ? "Crossref 题录高置信候选" : "Crossref 题录相似候选", upw);
    })
  );

  if (candidates.length < 3 || candidates.every((item) => item.confidence < 0.75)) {
    const openAlexItems = await openAlexSearch(input, env).catch(() => []);
    const extra = await Promise.all(openAlexItems.slice(0, 5).map((item: Record<string, unknown>) => toOpenAlexCandidate(item, "OpenAlex 模糊补充候选")));
    candidates = dedupeCandidates([...candidates, ...extra]).slice(0, 5);
  }

  return candidates;
}

async function crossrefByDoi(doi: string, env: Bindings) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(env.CROSSREF_MAILTO)}`;
  const res = await fetch(url, { headers: { "User-Agent": env.APP_USER_AGENT } });
  if (res.status === 404) throw new Error("Crossref 未找到该 DOI");
  if (!res.ok) throw new Error("Crossref DOI 查询失败");
  const data = await res.json<{ message: Record<string, unknown> }>();
  return data.message;
}

async function crossrefBibliographic(input: string, env: Bindings) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", input);
  url.searchParams.set("rows", "5");
  url.searchParams.set("mailto", env.CROSSREF_MAILTO);
  const res = await fetch(url.toString(), { headers: { "User-Agent": env.APP_USER_AGENT } });
  if (!res.ok) throw new Error("Crossref 题录查询失败");
  const data = await res.json<{ message?: { items?: Record<string, unknown>[] } }>();
  return data.message?.items ?? [];
}

async function openAlexByDoi(doi: string, env: Bindings) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("filter", `doi:https://doi.org/${doi}`);
  if (env.OPENALEX_API_KEY) url.searchParams.set("api_key", env.OPENALEX_API_KEY);
  const res = await fetch(url.toString(), { headers: { "User-Agent": env.APP_USER_AGENT } });
  if (!res.ok) throw new Error("OpenAlex DOI 查询失败");
  const data = await res.json<{ results?: Record<string, unknown>[] }>();
  return data.results?.[0] ?? null;
}

async function openAlexSearch(input: string, env: Bindings) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", input);
  url.searchParams.set("per-page", "10");
  if (env.OPENALEX_API_KEY) url.searchParams.set("api_key", env.OPENALEX_API_KEY);
  const res = await fetch(url.toString(), { headers: { "User-Agent": env.APP_USER_AGENT } });
  if (!res.ok) throw new Error("OpenAlex 检索失败");
  const data = await res.json<{ results?: Record<string, unknown>[] }>();
  return data.results ?? [];
}

async function unpaywallByDoi(doi: string, env: Bindings) {
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(env.UNPAYWALL_EMAIL)}`;
  const res = await fetch(url, { headers: { "User-Agent": env.APP_USER_AGENT } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Unpaywall 开放 PDF 检查失败");
  return res.json<Record<string, unknown>>();
}

function extractOpenPdf(upw: Record<string, unknown> | null): OpenPdfInfo | null {
  if (!upw || upw.is_oa !== true) return null;
  const loc = upw.best_oa_location as Record<string, unknown> | undefined;
  const pdfUrl = extractString(loc?.url_for_pdf);
  if (!loc || !pdfUrl) return null;
  return {
    pdfUrl,
    landingUrl: extractString(loc.url),
    license: extractString(loc.license),
    hostType: extractString(loc.host_type),
    version: extractString(loc.version),
    oaStatus: extractString(upw.oa_status)
  };
}

function toCrossrefCandidate(item: Record<string, unknown>, confidence: number, reason: string, upw?: Record<string, unknown> | null, openalex?: Record<string, unknown> | null): PaperCandidate {
  const doi = extractString(item.DOI)?.toLowerCase();
  const openPdf = extractOpenPdf(upw ?? null);
  return {
    id: doi ? stableId(doi) : crypto.randomUUID(),
    doi,
    title: firstString(item.title) || "Untitled",
    authors: formatCrossrefAuthors(item.author),
    journal: firstString(item["container-title"]),
    year: readCrossrefYear(item),
    volume: extractString(item.volume),
    issue: extractString(item.issue),
    pages: extractString(item.page),
    publisher: extractString(item.publisher),
    publisherUrl: extractString(item.URL),
    source: "Crossref",
    confidence,
    matchReason: openalex ? `${reason}；OpenAlex 已补充校验` : reason,
    isOa: upw?.is_oa === true,
    oaStatus: extractString(upw?.oa_status),
    license: openPdf?.license,
    pdfUrl: openPdf?.pdfUrl,
    pdfHostType: openPdf?.hostType
  };
}

async function toOpenAlexCandidate(item: Record<string, unknown>, reason: string): Promise<PaperCandidate> {
  const doi = extractDoi(extractString(item.doi) ?? "") ?? undefined;
  const source = (item.primary_location as Record<string, unknown> | undefined)?.source as Record<string, unknown> | undefined;
  const openAccess = item.open_access as Record<string, unknown> | undefined;
  const authorships = Array.isArray(item.authorships) ? item.authorships as Record<string, unknown>[] : [];
  return {
    id: doi ? stableId(doi) : extractString(item.id) ?? crypto.randomUUID(),
    doi,
    title: extractString(item.title) ?? "Untitled",
    authors: authorships.map((a) => extractString((a.author as Record<string, unknown> | undefined)?.display_name)).filter(Boolean) as string[],
    journal: extractString(source?.display_name),
    year: typeof item.publication_year === "number" ? item.publication_year : undefined,
    publisherUrl: extractString(item.doi) ?? extractString(item.id),
    source: "OpenAlex",
    confidence: 0.7,
    matchReason: reason,
    isOa: openAccess?.is_oa === true,
    oaStatus: extractString(openAccess?.oa_status),
    pdfUrl: extractString(openAccess?.oa_url)
  };
}

function dedupeCandidates(candidates: PaperCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.doi || candidate.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function upsertPaper(db: D1Database, candidate: PaperCandidate) {
  await db.prepare(
    "INSERT INTO papers (id, doi, title, journal, year, volume, issue, pages, authors_json, publisher, publisher_url, is_oa, oa_status, license, pdf_url) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET doi = excluded.doi, title = excluded.title, journal = excluded.journal, year = excluded.year, volume = excluded.volume, issue = excluded.issue, pages = excluded.pages, authors_json = excluded.authors_json, publisher = excluded.publisher, publisher_url = excluded.publisher_url, is_oa = excluded.is_oa, oa_status = excluded.oa_status, license = excluded.license, pdf_url = excluded.pdf_url, updated_at = CURRENT_TIMESTAMP"
  )
    .bind(candidate.id, candidate.doi ?? null, candidate.title, candidate.journal ?? null, candidate.year ?? null, candidate.volume ?? null, candidate.issue ?? null, candidate.pages ?? null, JSON.stringify(candidate.authors), candidate.publisher ?? null, candidate.publisherUrl ?? null, candidate.isOa ? 1 : 0, candidate.oaStatus ?? null, candidate.license ?? null, candidate.pdfUrl ?? null)
    .run();
}

async function getPaper(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM papers WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

async function getPaperByDoi(db: D1Database, doi: string) {
  return db.prepare("SELECT * FROM papers WHERE doi = ?").bind(doi).first<Record<string, unknown>>();
}

async function getUserTask(db: D1Database, id: string, userId: string) {
  return db.prepare("SELECT * FROM search_tasks WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<Record<string, unknown>>();
}

type NormalizedTaskResult = {
  inputType?: string;
  candidates: PaperCandidate[];
  message?: string;
  rawObject: Record<string, unknown>;
  rawArray?: unknown[];
};

function normalizeTaskResult(value: unknown): NormalizedTaskResult {
  const parsed = parseJson(value, null) as unknown;
  if (Array.isArray(parsed)) {
    const candidates = parsed.flatMap((item) => {
      const row = item as { candidates?: PaperCandidate[] };
      return Array.isArray(row.candidates) ? row.candidates : [];
    });
    return { inputType: "batch", candidates, rawObject: { items: parsed }, rawArray: parsed };
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    return {
      inputType: extractString(obj.inputType),
      candidates: Array.isArray(obj.candidates) ? obj.candidates as PaperCandidate[] : [],
      message: extractString(obj.message),
      rawObject: obj
    };
  }
  return { candidates: [], rawObject: {} };
}

function buildTaskSummary(row: Record<string, unknown>, result: NormalizedTaskResult) {
  const first = result.candidates[0];
  const input = extractString(row.input_text) ?? "";
  if (first) {
    return `${first.title}${result.candidates.length > 1 ? ` 等 ${result.candidates.length} 个相似结果` : ""}`;
  }
  return result.message || input.slice(0, 100) || "暂无候选结果";
}

async function enrichCandidatesWithStoredFiles(db: D1Database, candidates: PaperCandidate[], userId: string) {
  return Promise.all(candidates.map(async (candidate) => {
    const downloadRow = await db.prepare("SELECT r2_key FROM paper_downloads WHERE paper_id = ? AND user_id = ? ORDER BY datetime(created_at) DESC LIMIT 1")
      .bind(candidate.id, userId)
      .first<Record<string, unknown>>();
    const openKey = extractString(downloadRow?.r2_key) || candidate.openPdfR2Key;
    const exportRow = await db.prepare("SELECT r2_key FROM citation_exports WHERE paper_id = ? AND user_id = ? ORDER BY datetime(created_at) DESC LIMIT 1")
      .bind(candidate.id, userId)
      .first<Record<string, unknown>>();
    const citationKey = extractString(exportRow?.r2_key) || candidate.citationPdfR2Key;
    return {
      ...candidate,
      openPdfR2Key: openKey,
      openPdfDownloadUrl: openKey ? `/api/files?key=${encodeURIComponent(openKey)}` : undefined,
      citationPdfR2Key: citationKey,
      citationPdfDownloadUrl: citationKey ? `/api/files?key=${encodeURIComponent(citationKey)}` : undefined
    };
  }));
}

async function archiveFilesForCandidates(env: Bindings, userId: string, candidates: PaperCandidate[]) {
  const archived: PaperCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.isOa) {
      try {
        const result = await saveCitationPdf(env, candidate, userId, "未找到合法开放全文 PDF，已自动保存题录 PDF。");
        archived.push({
          ...candidate,
          citationPdfR2Key: result.r2Key,
          citationPdfDownloadUrl: `/api/files?key=${encodeURIComponent(result.r2Key)}`
        });
      } catch {
        archived.push(candidate);
      }
      continue;
    }
    if (!candidate.doi) {
      archived.push(candidate);
      continue;
    }
    try {
      const result = await downloadVerifiedOpenPdf(env, candidate.id, candidate.doi, userId);
      archived.push({
        ...candidate,
        openPdfR2Key: result.r2Key,
        openPdfDownloadUrl: `/api/files?key=${encodeURIComponent(result.r2Key)}`
      });
    } catch {
      archived.push(candidate);
    }
  }
  return archived;
}

async function saveCitationPdf(env: Bindings, paper: PaperCandidate, userId: string, note: string) {
  const key = `users/${userId}/papers/${paper.id}/citation.pdf`;
  const pdf = await buildCitationPdf(paper, note);
  await env.PAPER_BUCKET.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
  await env.DB.prepare("INSERT INTO citation_exports (id, paper_id, user_id, format, r2_key) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), paper.id, userId, "pdf", key)
    .run();
  return { r2Key: key };
}

async function downloadVerifiedOpenPdf(env: Bindings, paperId: string, doi: string, userId: string) {
  const existing = await env.DB.prepare("SELECT source_url, r2_key, license FROM paper_downloads WHERE paper_id = ? AND user_id = ? ORDER BY datetime(created_at) DESC LIMIT 1")
    .bind(paperId, userId)
    .first<Record<string, unknown>>();
  const existingKey = extractString(existing?.r2_key);
  if (existingKey && await env.PAPER_BUCKET.head(existingKey)) {
    return {
      r2Key: existingKey,
      sourceUrl: extractString(existing?.source_url) ?? "",
      license: extractString(existing?.license),
      oaStatus: undefined
    };
  }

  const upw = await unpaywallByDoi(doi, env);
  const openPdf = extractOpenPdf(upw);
  if (!openPdf) throw new Error("未找到合法开放 PDF。没有 OA PDF 时只能导出题录 PDF。");

  const res = await fetch(openPdf.pdfUrl, { headers: { "User-Agent": env.APP_USER_AGENT } });
  if (!res.ok) throw new Error("开放 PDF 下载失败");
  const contentType = res.headers.get("Content-Type")?.toLowerCase() ?? "";
  const buffer = await res.arrayBuffer();
  if (!isPdf(buffer)) throw new Error("下载内容不是有效 PDF，已阻止保存");
  if (contentType && !contentType.includes("pdf") && !contentType.includes("octet-stream")) {
    throw new Error("PDF 响应类型不合理，已阻止保存");
  }

  const key = `users/${userId}/papers/${paperId}/open.pdf`;
  await env.PAPER_BUCKET.put(key, buffer, { httpMetadata: { contentType: "application/pdf" } });
  await env.DB.prepare("UPDATE papers SET r2_pdf_key = ?, pdf_url = ?, license = ?, oa_status = ?, is_oa = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(key, openPdf.pdfUrl, openPdf.license ?? null, openPdf.oaStatus ?? null, paperId)
    .run();
  await env.DB.prepare("INSERT INTO paper_downloads (id, paper_id, user_id, source_url, r2_key, license) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), paperId, userId, openPdf.pdfUrl, key, openPdf.license ?? null)
    .run();

  return { r2Key: key, sourceUrl: openPdf.pdfUrl, license: openPdf.license, oaStatus: openPdf.oaStatus };
}

function isPdf(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer.slice(0, 5));
  return String.fromCharCode(...bytes) === "%PDF-";
}

async function buildCitationPdf(paper: PaperCandidate, note: string) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 742;

  const draw = (text: string, size = 11, isBold = false) => {
    const lines = wrapText(safePdfText(text), size, isBold ? bold : font, 520);
    for (const line of lines) {
      page.drawText(line, { x: 46, y, size, font: isBold ? bold : font, color: rgb(0.08, 0.09, 0.11) });
      y -= size + 7;
    }
  };

  draw("ChemPaper Finder Citation Export", 18, true);
  y -= 10;
  draw(note, 10);
  y -= 10;
  draw(`Title: ${paper.title}`, 12, true);
  draw(`Authors: ${paper.authors.join(", ") || "Unknown"}`);
  draw(`Journal: ${paper.journal || "Unknown"}`);
  draw(`Year: ${paper.year ?? "Unknown"}`);
  draw(`Volume/Issue/Pages: ${[paper.volume, paper.issue, paper.pages].filter(Boolean).join(", ") || "Unknown"}`);
  draw(`DOI: ${paper.doi || "Unknown"}`);
  draw(`Publisher URL: ${paper.publisherUrl || (paper.doi ? `https://doi.org/${paper.doi}` : "Unknown")}`);
  draw(`Open Access: ${paper.isOa ? "Yes" : "No legal open PDF found"}`);
  draw(`OA Status: ${paper.oaStatus || "Unknown"}`);
  draw(`License: ${paper.license || "Unknown"}`);
  y -= 10;
  draw(`BibTeX:\n${buildBibTeX(paper)}`, 9);

  return doc.save();
}

function wrapText(text: string, size: number, font: PDFFontLike, maxWidth: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

type PDFFontLike = { widthOfTextAtSize(text: string, size: number): number };

function toCandidateFromRow(row: Record<string, unknown>): PaperCandidate {
  return {
    id: String(row.id),
    doi: extractString(row.doi),
    title: extractString(row.title) ?? "Untitled",
    authors: parseJson(row.authors_json, []),
    journal: extractString(row.journal),
    year: typeof row.year === "number" ? row.year : Number(row.year) || undefined,
    volume: extractString(row.volume),
    issue: extractString(row.issue),
    pages: extractString(row.pages),
    publisher: extractString(row.publisher),
    publisherUrl: extractString(row.publisher_url),
    source: "Crossref",
    confidence: 1,
    matchReason: "本地已确认记录",
    isOa: row.is_oa === 1,
    oaStatus: extractString(row.oa_status),
    license: extractString(row.license),
    pdfUrl: extractString(row.pdf_url)
  };
}

function buildCsv(papers: PaperCandidate[]) {
  const header = ["title", "authors", "journal", "year", "volume", "issue", "pages", "doi", "is_oa", "oa_status", "license", "publisher_url"];
  const rows = papers.map((paper) => [
    paper.title,
    paper.authors.join("; "),
    paper.journal ?? "",
    String(paper.year ?? ""),
    paper.volume ?? "",
    paper.issue ?? "",
    paper.pages ?? "",
    paper.doi ?? "",
    paper.isOa ? "yes" : "no",
    paper.oaStatus ?? "",
    paper.license ?? "",
    paper.publisherUrl ?? ""
  ]);
  return [header, ...rows].map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
}

function buildBibTeX(paper: PaperCandidate) {
  const key = safeFilename(`${paper.authors[0]?.split(/\s+/).at(-1) || "paper"}${paper.year || ""}`);
  return [
    `@article{${key},`,
    `  title = {${paper.title}},`,
    `  author = {${paper.authors.join(" and ")}},`,
    paper.journal ? `  journal = {${paper.journal}},` : "",
    paper.year ? `  year = {${paper.year}},` : "",
    paper.volume ? `  volume = {${paper.volume}},` : "",
    paper.issue ? `  number = {${paper.issue}},` : "",
    paper.pages ? `  pages = {${paper.pages}},` : "",
    paper.doi ? `  doi = {${paper.doi}},` : "",
    "}"
  ].filter(Boolean).join("\n");
}

function downloadHeaders(filename: string, contentType: string) {
  return {
    "Content-Type": contentType,
    "Content-Disposition": contentDisposition(filename),
    "Cache-Control": "no-store"
  };
}

function contentDisposition(filename: string) {
  const safe = safeFilename(filename.replace(/\.[a-z0-9]+$/i, "")) + (filename.match(/\.[a-z0-9]+$/i)?.[0] ?? "");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function formatCrossrefAuthors(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.map((author) => {
    const a = author as Record<string, unknown>;
    return [extractString(a.given), extractString(a.family)].filter(Boolean).join(" ") || extractString(a.name);
  }).filter(Boolean) as string[];
}

function readCrossrefYear(item: Record<string, unknown>) {
  const issued = item.issued as { "date-parts"?: number[][] } | undefined;
  const published = item.published as { "date-parts"?: number[][] } | undefined;
  return issued?.["date-parts"]?.[0]?.[0] ?? published?.["date-parts"]?.[0]?.[0];
}

function firstString(value: unknown) {
  return Array.isArray(value) ? extractString(value[0]) : extractString(value);
}

function extractString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stableId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || crypto.randomUUID();
}

function safeFilename(value: string) {
  return stableId(value).slice(0, 80) || "paper";
}

function makeShortId(length = 11) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function safePdfText(value: string) {
  return value.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "?");
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function toUserMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求处理失败，请稍后重试";
}
