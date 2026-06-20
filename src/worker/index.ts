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

type SiteSettings = {
  landingBackgroundKey?: string;
  landingBackgroundOpacity: number;
  updatedAt?: string;
};

type OpenPdfInfo = {
  id?: string;
  source?: string;
  pdfUrl: string;
  landingUrl?: string;
  license?: string;
  hostType?: string;
  version?: string;
  oaStatus?: string;
  pdfVersionType?: string;
  isPublisherVersion?: boolean;
  score?: number;
  sourceGranularity?: string;
  derivedFrom?: string;
};

type PaperCandidate = {
  id: string;
  doi?: string;
  preprintDoi?: string;
  publishedDoi?: string;
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  publisherUrl?: string;
  source: string;
  confidence: number;
  matchReason: string;
  isOa: boolean;
  oaStatus?: string;
  license?: string;
  pdfUrl?: string;
  pdfHostType?: string;
  pdfSource?: string;
  pdfVersionType?: string;
  pdfCandidateId?: string;
  sourceUrl?: string;
  sourceGranularity?: string;
  derivedFrom?: string;
  fileSize?: number;
  downloadedAt?: string;
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

app.get("/api/site-settings", async (c) => {
  await ensureSchema(c.env.DB);
  const settings = await readSiteSettings(c.env);
  return c.json({ success: true, settings: publicSiteSettings(settings) });
});

app.get("/api/site-background", async (c) => {
  await ensureSchema(c.env.DB);
  const settings = await readSiteSettings(c.env);
  if (!settings.landingBackgroundKey) return c.text("Not found", 404);
  const object = await c.env.PAPER_BUCKET.get(settings.landingBackgroundKey);
  if (!object) return c.text("Not found", 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=300");
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
});

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
  const quota = await readQuotaSnapshot(c.env, user.uuid);

  return c.json({ success: true, user, token, quota });
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
  if (c.req.path === "/api/config" || c.req.path === "/api/health" || c.req.path === "/api/site-settings" || c.req.path === "/api/site-background" || c.req.path === "/api/sso-callback" || c.req.path === "/api/signout" || c.req.path === "/api/track") {
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

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const quota = await readQuotaSnapshot(c.env, user.uuid);
  return c.json({ success: true, user, quota });
});

app.get("/api/admin/site-settings", async (c) => {
  if (!isAdminUser(c.get("user"))) return c.json({ success: false, message: "需要管理员权限" }, 403);
  const settings = await readSiteSettings(c.env);
  return c.json({ success: true, settings: publicSiteSettings(settings) });
});

app.patch("/api/admin/site-settings", async (c) => {
  if (!isAdminUser(c.get("user"))) return c.json({ success: false, message: "需要管理员权限" }, 403);
  const body = await c.req.json<{ landingBackgroundOpacity?: number }>().catch(() => ({} as { landingBackgroundOpacity?: number }));
  const opacity = clampOpacity(Number(body.landingBackgroundOpacity));
  await writeSiteSetting(c.env.DB, "landing_background_opacity", String(opacity));
  const settings = await readSiteSettings(c.env);
  return c.json({ success: true, settings: publicSiteSettings(settings) });
});

app.post("/api/admin/landing-background", async (c) => {
  if (!isAdminUser(c.get("user"))) return c.json({ success: false, message: "需要管理员权限" }, 403);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ success: false, message: "请上传背景图片文件" }, 400);
  const ext = imageExtension(file.type);
  if (!ext) return c.json({ success: false, message: "仅支持 JPG、PNG、WebP 或 GIF 图片" }, 400);
  if (file.size > 5 * 1024 * 1024) return c.json({ success: false, message: "图片不能超过 5MB" }, 400);

  const previous = await readSiteSettings(c.env);
  const key = `site/landing-background-${Date.now()}.${ext}`;
  await c.env.PAPER_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  await writeSiteSetting(c.env.DB, "landing_background_key", key, c.get("user").uuid);
  const opacityValue = form?.get("opacity");
  if (typeof opacityValue === "string") {
    await writeSiteSetting(c.env.DB, "landing_background_opacity", String(clampOpacity(Number(opacityValue))), c.get("user").uuid);
  }
  if (previous.landingBackgroundKey && previous.landingBackgroundKey !== key) {
    c.executionCtx.waitUntil(c.env.PAPER_BUCKET.delete(previous.landingBackgroundKey).catch(() => undefined));
  }
  const settings = await readSiteSettings(c.env);
  return c.json({ success: true, settings: publicSiteSettings(settings) });
});

app.delete("/api/admin/landing-background", async (c) => {
  if (!isAdminUser(c.get("user"))) return c.json({ success: false, message: "需要管理员权限" }, 403);
  const settings = await readSiteSettings(c.env);
  if (settings.landingBackgroundKey) await c.env.PAPER_BUCKET.delete(settings.landingBackgroundKey);
  await writeSiteSetting(c.env.DB, "landing_background_key", "", c.get("user").uuid);
  await writeSiteSetting(c.env.DB, "landing_background_opacity", "0.28", c.get("user").uuid);
  return c.json({ success: true, settings: publicSiteSettings(await readSiteSettings(c.env)) });
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
  const candidateId = extractString((body as Record<string, unknown>).candidateId) || extractString((body as Record<string, unknown>).candidate_id);

  const paper = "paperId" in parsed.data
    ? await getPaper(c.env.DB, parsed.data.paperId)
    : await getPaperByDoi(c.env.DB, extractDoi(parsed.data.doi) ?? "");
  const paperDoi = extractString(paper?.doi);
  const paperId = extractString(paper?.id);
  const doi = "doi" in parsed.data ? extractDoi(parsed.data.doi) : paperDoi;
  if (!doi && !paperId) return c.json({ success: false, message: "该文献缺少本地记录，无法自动下载开放 PDF" }, 400);

  try {
    const result = await downloadVerifiedOpenPdf(c.env, paperId ?? stableId(doi ?? ""), doi, c.get("user").uuid, candidateId);
    c.executionCtx.waitUntil(consumeQuota(c.env, c.get("user").uuid, 0));
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
      const candidates = await lookupCandidates(line, type, c.env, c.get("user").uuid);
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
  c.executionCtx.waitUntil(consumeQuota(c.env, c.get("user").uuid, 0));

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

app.post("/api/papers/:id/oa-check", async (c) => {
  const paper = await getPaper(c.env.DB, c.req.param("id"));
  if (!paper) return c.json({ success: false, message: "未找到文献" }, 404);
  const candidate = toCandidateFromRow(paper);
  const pdfCandidates = await upsertPdfCandidates(c.env, candidate, c.get("user").uuid);
  return c.json({ success: true, candidates: pdfCandidates.map((item) => toPdfCandidateResponse(pdfCandidateToRow(item, candidate.id))) });
});

app.post("/api/papers/:id/download-open-pdf", async (c) => {
  const paper = await getPaper(c.env.DB, c.req.param("id"));
  if (!paper) return c.json({ success: false, message: "未找到文献" }, 404);
  const doi = extractString(paper.doi);
  const body = await c.req.json<{ candidateId?: string; candidate_id?: string }>().catch(() => ({} as { candidateId?: string; candidate_id?: string }));
  const candidateId = extractString(body.candidateId) || extractString(body.candidate_id);
  try {
    const result = await downloadVerifiedOpenPdf(c.env, c.req.param("id"), doi, c.get("user").uuid, candidateId);
    return c.json({ success: true, ...result, downloadUrl: `/api/files?key=${encodeURIComponent(result.r2Key)}` });
  } catch (error) {
    return c.json({ success: false, message: toUserMessage(error) }, 409);
  }
});

app.post("/api/papers/:id/export-citation-pdf", async (c) => {
  const paper = await getPaper(c.env.DB, c.req.param("id"));
  if (!paper) return c.json({ success: false, message: "未找到文献" }, 404);
  const result = await saveCitationPdf(c.env, toCandidateFromRow(paper), c.get("user").uuid, "未找到合法开放全文 PDF 时，仅导出题录信息。");
  return c.json({ success: true, ...result, downloadUrl: `/api/files?key=${encodeURIComponent(result.r2Key)}` });
});

app.get("/api/papers/:id/download", async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key FROM paper_files WHERE paper_id = ? AND user_id = ? AND file_type = ? ORDER BY datetime(downloaded_at) DESC LIMIT 1")
    .bind(c.req.param("id"), c.get("user").uuid, "open_pdf")
    .first<Record<string, unknown>>();
  const key = extractString(row?.r2_key);
  if (!key) return c.json({ success: false, message: "还没有保存开放 PDF" }, 404);
  const url = new URL(c.req.url);
  url.pathname = "/api/files";
  url.search = `?key=${encodeURIComponent(key)}`;
  return c.redirect(url.toString(), 302);
});

app.get("/api/papers/:id", async (c) => {
  const paper = await getPaper(c.env.DB, c.req.param("id"));
  if (!paper) return c.json({ success: false, message: "未找到文献" }, 404);
  return c.json({
    success: true,
    paper: toCandidateFromRow(paper),
    pdfCandidates: await listPdfCandidates(c.env.DB, c.req.param("id")),
    files: await listPaperFiles(c.env.DB, c.req.param("id"), c.get("user").uuid),
    raw: paper
  });
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
  await c.env.DB.prepare("DELETE FROM paper_files WHERE user_id = ? AND r2_key = ?")
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
    const candidates = await lookupCandidates(input, inputType, env, userId);
    await Promise.all(candidates.map((candidate) => upsertPaper(env.DB, candidate)));
    const archivedCandidates = await archiveFilesForCandidates(env, userId, candidates);
    await env.DB.prepare("UPDATE search_tasks SET status = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind("completed", JSON.stringify({ inputType, candidates: archivedCandidates }), taskId)
      .run();
    await consumeQuota(env, userId, 0);
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
    "CREATE TABLE IF NOT EXISTS papers (id TEXT PRIMARY KEY, doi TEXT UNIQUE, title TEXT, journal TEXT, year INTEGER, volume TEXT, issue TEXT, pages TEXT, authors_json TEXT, publisher TEXT, publisher_url TEXT, abstract TEXT, crossref_json TEXT, openalex_json TEXT, unpaywall_json TEXT, is_oa INTEGER DEFAULT 0, oa_status TEXT, license TEXT, pdf_url TEXT, r2_pdf_key TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS paper_pdf_candidates (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, source TEXT, pdf_url TEXT NOT NULL, landing_url TEXT, host_type TEXT, version TEXT, license TEXT, pdf_version_type TEXT, source_granularity TEXT, derived_from TEXT, is_publisher_version INTEGER DEFAULT 0, score REAL DEFAULT 0, verified INTEGER DEFAULT 0, verification_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS paper_files (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, candidate_id TEXT, user_id TEXT, r2_key TEXT NOT NULL, file_type TEXT, content_type TEXT, file_size INTEGER, content_hash TEXT, source_url TEXT, license TEXT, downloaded_at TEXT DEFAULT CURRENT_TIMESTAMP, created_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS search_tasks (id TEXT PRIMARY KEY, user_id TEXT, input_text TEXT NOT NULL, input_type TEXT, status TEXT DEFAULT 'pending', result_json TEXT, error_message TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS paper_downloads (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, user_id TEXT, source_url TEXT, r2_key TEXT, license TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS citation_exports (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, user_id TEXT, format TEXT, r2_key TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT, updated_by TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)"
  ];
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  await addColumnIfMissing(db, "papers", "abstract", "TEXT");
  await addColumnIfMissing(db, "search_tasks", "error_message", "TEXT");
  await addColumnIfMissing(db, "paper_pdf_candidates", "source_granularity", "TEXT");
  await addColumnIfMissing(db, "paper_pdf_candidates", "derived_from", "TEXT");
}

async function addColumnIfMissing(db: D1Database, table: string, column: string, type: string) {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch {
    // Column already exists on upgraded databases.
  }
}

async function readSiteSettings(env: Bindings): Promise<SiteSettings> {
  const rows = await env.DB.prepare("SELECT key, value, updated_at FROM site_settings WHERE key IN (?, ?)")
    .bind("landing_background_key", "landing_background_opacity")
    .all<Record<string, unknown>>();
  const map = new Map((rows.results ?? []).map((row) => [extractString(row.key) ?? "", row]));
  const keyRow = map.get("landing_background_key");
  const opacityRow = map.get("landing_background_opacity");
  return {
    landingBackgroundKey: extractString(keyRow?.value),
    landingBackgroundOpacity: clampOpacity(Number(extractString(opacityRow?.value) ?? 0.28)),
    updatedAt: extractString(keyRow?.updated_at) || extractString(opacityRow?.updated_at)
  };
}

async function writeSiteSetting(db: D1Database, key: string, value: string, updatedBy?: string) {
  await db.prepare(
    "INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP"
  )
    .bind(key, value, updatedBy ?? null)
    .run();
}

function publicSiteSettings(settings: SiteSettings) {
  return {
    landingBackgroundUrl: settings.landingBackgroundKey ? `/api/site-background?v=${encodeURIComponent(settings.updatedAt ?? settings.landingBackgroundKey)}` : "",
    landingBackgroundOpacity: settings.landingBackgroundOpacity,
    updatedAt: settings.updatedAt
  };
}

function clampOpacity(value: number) {
  if (!Number.isFinite(value)) return 0.28;
  return Math.min(0.82, Math.max(0, Math.round(value * 100) / 100));
}

function imageExtension(type: string) {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif"
  };
  return map[type.toLowerCase()];
}

function isAdminUser(user: UserProfile) {
  return /^(admin|owner|super_admin|root)$/i.test(user.role ?? "");
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

async function readQuotaSnapshot(env: Bindings, uuid: string) {
  const quota = await checkQuota(env, uuid);
  if (quota.ok) return { ok: true, data: quota.data };
  return { ok: false, status: quota.status, message: quota.message };
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

async function meteredKeyedFetch(env: Bindings, uuid: string | undefined, apiName: string, metered: boolean, input: RequestInfo | URL, init?: RequestInit) {
  if (!metered || !uuid || String(env.ENABLE_QUOTA) !== "true") {
    return fetch(input, init);
  }
  const quota = await checkQuota(env, uuid);
  if (!quota.ok) {
    throw new Error(`${apiName} API 用量限制：${quota.message}`);
  }
  const res = await fetch(input, init);
  await consumeQuota(env, uuid, 0);
  return res;
}

function readGeminiTotalTokens(data: unknown) {
  const usage = data && typeof data === "object" ? (data as Record<string, unknown>).usageMetadata as Record<string, unknown> | undefined : undefined;
  const total = usage?.totalTokenCount;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
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

async function lookupCandidates(input: string, type: string, env: Bindings, userId?: string) {
  const normalized = normalizeSearchInput(input);
  if (type === "doi") {
    const doi = extractDoi(normalized.primary);
    if (!doi) throw new Error("DOI 格式不正确");
    const [crossref, openalex, upw] = await Promise.all([
      crossrefByDoi(doi, env).catch(() => null),
      openAlexByDoi(doi, env, userId).catch(() => null),
      unpaywallByDoi(doi, env).catch(() => null)
    ]);
    const candidates: PaperCandidate[] = [];
    if (crossref) candidates.push(toCrossrefCandidate(crossref, 1, "DOI 精确匹配", upw, openalex));
    if (openalex) candidates.push(await toOpenAlexCandidate(openalex, crossref ? "OpenAlex DOI 补充候选" : "OpenAlex DOI 精确候选", 0.94));
    const chemQuery = crossref ? firstString(crossref.title) || doi : openalex ? extractString(openalex.title) || doi : doi;
    candidates.push(...await chemRxivSearchCandidates(chemQuery, env));
    candidates.push(...await oldLiteratureSearchCandidates(normalized.primary, env));
    return dedupeCandidates(candidates).slice(0, 10);
  }

  const [crossrefItems, openAlexItems, chemRxivItems, oldItems] = await Promise.all([
    crossrefBibliographic(normalized.primary, env).catch(() => []),
    openAlexSearch(normalized.primary, env, userId).catch(() => []),
    chemRxivSearchCandidates(normalized.primary, env).catch(() => []),
    oldLiteratureSearchCandidates(normalized.primary, env).catch(() => [])
  ]);
  const crossrefCandidates = await Promise.all(
    crossrefItems.slice(0, 5).map(async (item: Record<string, unknown>) => {
      const doi = extractString(item.DOI);
      const upw = doi ? await unpaywallByDoi(doi, env).catch(() => null) : null;
      const score = typeof item.score === "number" ? Math.min(0.92, Math.max(0.55, item.score / 120)) : 0.72;
      return toCrossrefCandidate(item, score, score >= 0.9 ? "Crossref 题录高置信候选" : "Crossref 题录相似候选", upw);
    })
  );
  const openAlexCandidates = await Promise.all(openAlexItems.slice(0, 6).map((item: Record<string, unknown>) => toOpenAlexCandidate(item, "OpenAlex 语义/题名补充候选", 0.78)));

  return dedupeCandidates([...crossrefCandidates, ...openAlexCandidates, ...chemRxivItems, ...oldItems])
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
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

async function openAlexByDoi(doi: string, env: Bindings, userId?: string) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("filter", `doi:https://doi.org/${doi}`);
  if (env.OPENALEX_API_KEY) url.searchParams.set("api_key", env.OPENALEX_API_KEY);
  const res = await meteredKeyedFetch(env, userId, "OpenAlex", Boolean(env.OPENALEX_API_KEY), url.toString(), { headers: { "User-Agent": env.APP_USER_AGENT } });
  if (!res.ok) throw new Error("OpenAlex DOI 查询失败");
  const data = await res.json<{ results?: Record<string, unknown>[] }>();
  return data.results?.[0] ?? null;
}

async function openAlexSearch(input: string, env: Bindings, userId?: string) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", input);
  url.searchParams.set("per-page", "10");
  if (env.OPENALEX_API_KEY) url.searchParams.set("api_key", env.OPENALEX_API_KEY);
  const res = await meteredKeyedFetch(env, userId, "OpenAlex", Boolean(env.OPENALEX_API_KEY), url.toString(), { headers: { "User-Agent": env.APP_USER_AGENT } });
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
  const info = {
    source: "Unpaywall",
    pdfUrl,
    landingUrl: extractString(loc.url),
    license: extractString(loc.license),
    hostType: extractString(loc.host_type),
    version: extractString(loc.version),
    oaStatus: extractString(upw.oa_status)
  };
  return withPdfClassification(info);
}

function withPdfClassification(info: OpenPdfInfo): OpenPdfInfo {
  const versionType = classifyPdfVersion(info.source, info.hostType, info.version);
  const isPublisherVersion = versionType === "publisher_version_of_record";
  return {
    ...info,
    pdfVersionType: versionType,
    isPublisherVersion,
    score: scorePdfCandidate({ ...info, pdfVersionType: versionType, isPublisherVersion })
  };
}

async function collectPdfCandidates(paper: PaperCandidate, env: Bindings, userId?: string) {
  const candidates: OpenPdfInfo[] = [];
  if (paper.doi) {
    const upw = await unpaywallByDoi(paper.doi, env).catch(() => null);
    const open = extractOpenPdf(upw);
    if (open) candidates.push(open);
    const openalex = await openAlexByDoi(paper.doi, env, userId).catch(() => null);
    candidates.push(...extractOpenAlexPdfCandidates(openalex));
  }
  candidates.push(...await corePdfCandidates(paper, env, userId));
  candidates.push(...await chemRxivPdfCandidates(paper, env));
  candidates.push(...await oldLiteratureScanPdfCandidates(paper, env));
  if (paper.pdfUrl) {
    candidates.push(withPdfClassification({
      source: paper.pdfSource || paper.source,
      pdfUrl: paper.pdfUrl,
      hostType: paper.pdfHostType,
      license: paper.license,
      oaStatus: paper.oaStatus
    }));
  }
  return dedupePdfCandidates(candidates)
    .map((candidate) => ({ ...candidate, id: stableId(`${paper.id}-${candidate.source}-${candidate.pdfUrl}`) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function extractOpenAlexPdfCandidates(openalex: Record<string, unknown> | null) {
  if (!openalex) return [];
  const locations = [
    openalex.best_oa_location,
    openalex.primary_location,
    ...(Array.isArray(openalex.locations) ? openalex.locations : [])
  ].filter(Boolean) as Record<string, unknown>[];

  return locations.map((loc) => {
    const pdfUrl = extractString(loc.pdf_url);
    if (!pdfUrl) return null;
    const source = loc.source as Record<string, unknown> | undefined;
    return withPdfClassification({
      source: "OpenAlex",
      pdfUrl,
      landingUrl: extractString(loc.landing_page_url),
      license: extractString(loc.license),
      hostType: extractString(loc.host_type) || extractString(source?.host_organization_lineage_names),
      version: extractString(loc.version)
    });
  }).filter(Boolean) as OpenPdfInfo[];
}

async function corePdfCandidates(paper: PaperCandidate, env: Bindings, userId?: string) {
  const apiKey = optionalEnv(env, "CORE_API_KEY");
  if (!apiKey) return [];
  const query = paper.doi ? `doi:"${paper.doi}"` : paper.title;
  if (!query) return [];

  const url = new URL("https://api.core.ac.uk/v3/search/works");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  const res = await meteredKeyedFetch(env, userId, "CORE", true, url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": env.APP_USER_AGENT
    }
  }).catch(() => null);
  if (!res?.ok) return [];

  const data = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const results = Array.isArray(data.results) ? data.results as Record<string, unknown>[] : [];
  return results.map((item) => {
    const pdfUrl = findFirstString(item, ["downloadUrl", "download_url", "fullTextUrl", "full_text_url", "pdfUrl", "pdf_url"]);
    if (!pdfUrl) return null;
    return withPdfClassification({
      source: "CORE",
      pdfUrl,
      landingUrl: findFirstString(item, ["sourceFulltextUrls", "publisherUrl", "url", "oai"]),
      license: findFirstString(item, ["license", "documentType"]),
      hostType: "repository",
      version: "acceptedVersion"
    });
  }).filter(Boolean) as OpenPdfInfo[];
}

async function chemRxivPdfCandidates(paper: PaperCandidate, env: Bindings) {
  const query = paper.doi || paper.title;
  if (!query) return [];
  const results = await chemRxivSearch(query, env);
  return results.map((item) => {
    const pdfUrl = findFirstUrlDeep(item, ["pdfUrl", "pdf_url", "downloadUrl", "download_url", "assetUrl", "asset_url", "url"], true);
    if (!pdfUrl) return null;
    return withPdfClassification({
      source: "ChemRxiv",
      pdfUrl,
      landingUrl: findFirstUrlDeep(item, ["url", "landingUrl", "landing_page_url", "doi"], false),
      license: findFirstStringDeep(item, ["license", "licenseName", "license_name"]),
      hostType: "preprint",
      version: "preprint"
    });
  }).filter(Boolean) as OpenPdfInfo[];
}

function readResultArray(data: Record<string, unknown>) {
  for (const key of ["results", "items", "itemHits", "data"]) {
    const value = data[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  const nested = data.result as Record<string, unknown> | undefined;
  if (nested) return readResultArray(nested);
  return [];
}

function findFirstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const first = value.map((item) => typeof item === "string" ? item : undefined).find(Boolean);
      if (first) return first;
    }
  }
  return undefined;
}

function normalizeSearchInput(input: string) {
  const doi = extractDoi(input);
  if (doi) return { primary: doi, doi };
  const normalizedJournals = normalizeJournalTitle(input);
  return {
    primary: normalizedJournals
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/\s*[,;]\s*/g, ", ")
      .replace(/^doi:\s*/i, "")
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .trim()
  };
}

type BibliographicHints = {
  title?: string;
  journal?: string;
  year?: number;
  volume?: string;
  issue?: string;
  pages?: string;
  author?: string;
  oclc?: string;
  lccn?: string;
  htid?: string;
};

function parseBibliographicHints(input: string): BibliographicHints {
  const normalized = normalizeSearchInput(input).primary;
  const year = normalized.match(/\b(18|19|20)\d{2}\b/)?.[0];
  const pageRange = normalized.match(/\b(\d{1,5})\s*[-–—]\s*(\d{1,5})\b/)?.[0]?.replace(/[–—]/g, "-");
  const afterYear = year ? normalized.slice(normalized.indexOf(year) + year.length) : "";
  const nums = afterYear.match(/\b\d+\b/g) ?? [];
  const beforeYear = year ? normalized.slice(0, normalized.indexOf(year)).replace(/[,.;\s]+$/g, "") : normalized;
  const author = beforeYear.includes(",") ? beforeYear.split(",")[0]?.trim() : undefined;
  const oclc = normalized.match(/\bOCLC[:\s#-]*(\d{3,})\b/i)?.[1];
  const lccn = normalized.match(/\bLCCN[:\s#-]*([a-z0-9-]{4,})\b/i)?.[1];
  const htid = normalized.match(/\bHTID[:\s#-]*([a-z0-9._:-]{4,})\b/i)?.[1];
  return {
    title: normalized,
    journal: normalizeJournalTitle(beforeYear || normalized),
    year: year ? Number(year) : undefined,
    volume: nums[0],
    issue: nums.length > 2 ? nums[1] : undefined,
    pages: pageRange,
    author,
    oclc,
    lccn,
    htid
  };
}

function normalizeJournalTitle(value: string) {
  const replacements: Array<[RegExp, string]> = [
    [/\bJ\.?\s*Am\.?\s*Chem\.?\s*Soc\.?\b/gi, "Journal of the American Chemical Society"],
    [/\bJ\.?\s*Phys\.?\s*Chem\.?\b/gi, "The Journal of Physical Chemistry"],
    [/\bBer\.?\s*Dtsch\.?\s*Chem\.?\s*Ges\.?\b/gi, "Berichte der Deutschen Chemischen Gesellschaft"],
    [/\bJustus\s+Liebigs\s+Ann\.?\s*Chem\.?\b/gi, "Justus Liebigs Annalen der Chemie"]
  ];
  return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function findFirstStringDeep(input: unknown, keys: string[]): string | undefined {
  const seen = new Set<unknown>();
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const visit = (value: unknown): string | undefined => {
    if (!value || seen.has(value)) return undefined;
    if (typeof value === "string") return undefined;
    if (typeof value !== "object") return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) return item.trim();
        const found = visit(item);
        if (found) return found;
      }
      return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (wanted.has(key.toLowerCase()) && typeof child === "string" && child.trim()) return child.trim();
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(input);
}

function findFirstUrlDeep(input: unknown, keys: string[], preferPdf: boolean) {
  const urls: string[] = [];
  const seen = new Set<unknown>();
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const visit = (value: unknown, keyHint = "") => {
    if (!value || seen.has(value)) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^https?:\/\//i.test(trimmed) && (!keyHint || wanted.has(keyHint.toLowerCase()) || /\.pdf([?#]|$)/i.test(trimmed))) urls.push(trimmed);
      return;
    }
    if (typeof value !== "object") return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, keyHint));
      return;
    }
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) => visit(child, key));
  };
  visit(input);
  if (preferPdf) return urls.find((url) => /\.pdf([?#]|$)/i.test(url)) || urls[0];
  return urls.find((url) => !/\.pdf([?#]|$)/i.test(url)) || urls[0];
}

function readAuthors(input: Record<string, unknown>) {
  const raw = input.authors ?? input.author ?? input.creators;
  if (!Array.isArray(raw)) {
    const single = findFirstStringDeep(input, ["author", "authors"]);
    return single ? [single] : [];
  }
  return raw.map((item) => {
    if (typeof item === "string") return item;
    const record = item as Record<string, unknown>;
    return extractString(record.name) || extractString(record.fullName) || [extractString(record.given), extractString(record.family)].filter(Boolean).join(" ");
  }).filter(Boolean) as string[];
}

function readYearFromUnknown(input: Record<string, unknown>) {
  const value = findFirstStringDeep(input, ["publishedDate", "published_date", "date", "createdDate"]);
  const match = value?.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

function dedupePdfCandidates(candidates: OpenPdfInfo[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.pdfUrl.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyPdfVersion(source?: string, hostType?: string, version?: string) {
  const joined = `${source ?? ""} ${hostType ?? ""} ${version ?? ""}`.toLowerCase();
  if (joined.includes("chemrxiv") || joined.includes("arxiv") || joined.includes("preprint")) return "preprint";
  if (joined.includes("volume_scan")) return "repository_copy";
  if (joined.includes("accepted")) return "author_accepted_manuscript";
  if (joined.includes("publisher") && (joined.includes("publishedversion") || joined.includes("version-of-record"))) return "publisher_version_of_record";
  if (joined.includes("repository")) return "repository_copy";
  return "unknown_version";
}

function scorePdfCandidate(candidate: OpenPdfInfo) {
  let score = candidate.pdfUrl ? 20 : 0;
  if (candidate.hostType?.toLowerCase().includes("publisher")) score += 30;
  if (candidate.version?.toLowerCase().includes("published")) score += 25;
  if (candidate.license) score += 12;
  if (candidate.source === "Unpaywall") score += 12;
  if (candidate.source === "OpenAlex") score += 8;
  if (candidate.pdfVersionType === "author_accepted_manuscript") score += 6;
  if (candidate.pdfVersionType === "preprint") score -= 5;
  return score;
}

function toCrossrefCandidate(item: Record<string, unknown>, confidence: number, reason: string, upw?: Record<string, unknown> | null, openalex?: Record<string, unknown> | null): PaperCandidate {
  const doi = extractString(item.DOI)?.toLowerCase();
  const openPdf = extractOpenPdf(upw ?? null);
  const type = extractString(item.type)?.toLowerCase() || "";
  const container = firstString(item["container-title"]) || "";
  const isPreprint = type.includes("posted-content") || /chemrxiv/i.test(container);
  const publishedDoi = readCrossrefRelationDoi(item, ["is-preprint-of", "is-version-of", "has-preprint"]);
  return {
    id: doi ? stableId(doi) : crypto.randomUUID(),
    doi,
    preprintDoi: isPreprint ? doi : undefined,
    publishedDoi: isPreprint ? publishedDoi : undefined,
    title: firstString(item.title) || "Untitled",
    authors: formatCrossrefAuthors(item.author),
    journal: isPreprint && !container ? "ChemRxiv" : container,
    year: readCrossrefYear(item),
    volume: extractString(item.volume),
    issue: extractString(item.issue),
    pages: extractString(item.page),
    publisher: extractString(item.publisher),
    publisherUrl: extractString(item.URL),
    source: isPreprint ? "Crossref posted-content" : "Crossref",
    confidence,
    matchReason: `${openalex ? `${reason}；OpenAlex 已补充校验` : reason}${isPreprint ? "；预印本元数据" : ""}`,
    isOa: upw?.is_oa === true,
    oaStatus: isPreprint ? "preprint" : extractString(upw?.oa_status),
    license: openPdf?.license,
    pdfUrl: openPdf?.pdfUrl,
    pdfHostType: openPdf?.hostType,
    pdfSource: openPdf?.source,
    pdfVersionType: openPdf?.pdfVersionType,
    pdfCandidateId: openPdf ? stableId(`${doi ? stableId(doi) : "paper"}-${openPdf.source}-${openPdf.pdfUrl}`) : undefined,
    sourceUrl: openPdf?.landingUrl || openPdf?.pdfUrl
  };
}

async function toOpenAlexCandidate(item: Record<string, unknown>, reason: string, confidence = 0.7): Promise<PaperCandidate> {
  const doi = extractDoi(extractString(item.doi) ?? "") ?? undefined;
  const source = (item.primary_location as Record<string, unknown> | undefined)?.source as Record<string, unknown> | undefined;
  const openAccess = item.open_access as Record<string, unknown> | undefined;
  const authorships = Array.isArray(item.authorships) ? item.authorships as Record<string, unknown>[] : [];
  const chemRxivLocation = openAlexHasChemRxivLocation(item);
  return {
    id: doi ? stableId(doi) : extractString(item.id) ?? crypto.randomUUID(),
    doi,
    preprintDoi: chemRxivLocation ? doi : undefined,
    title: extractString(item.title) ?? "Untitled",
    authors: authorships.map((a) => extractString((a.author as Record<string, unknown> | undefined)?.display_name)).filter(Boolean) as string[],
    journal: chemRxivLocation ? "ChemRxiv" : extractString(source?.display_name),
    year: typeof item.publication_year === "number" ? item.publication_year : undefined,
    publisherUrl: extractString(item.doi) ?? extractString(item.id),
    source: chemRxivLocation ? "OpenAlex + ChemRxiv" : "OpenAlex",
    confidence,
    matchReason: chemRxivLocation ? `${reason}；OpenAlex locations 指向 ChemRxiv 预印本` : reason,
    isOa: openAccess?.is_oa === true,
    oaStatus: chemRxivLocation ? "preprint" : extractString(openAccess?.oa_status),
    pdfUrl: extractString(openAccess?.oa_url),
    pdfSource: chemRxivLocation ? "ChemRxiv" : "OpenAlex",
    pdfVersionType: chemRxivLocation ? "preprint" : undefined,
    sourceUrl: extractString(openAccess?.oa_url)
  };
}

function openAlexHasChemRxivLocation(item: Record<string, unknown>) {
  const locations = [
    item.best_oa_location,
    item.primary_location,
    ...(Array.isArray(item.locations) ? item.locations : [])
  ].filter(Boolean) as Record<string, unknown>[];
  return locations.some((loc) => {
    const source = loc.source as Record<string, unknown> | undefined;
    return [
      extractString(loc.landing_page_url),
      extractString(loc.pdf_url),
      extractString(source?.display_name),
      extractString(source?.host_organization_name)
    ].filter(Boolean).some((value) => /chemrxiv/i.test(value ?? ""));
  });
}

function readCrossrefRelationDoi(item: Record<string, unknown>, relationKeys: string[]) {
  const relation = item.relation as Record<string, unknown> | undefined;
  if (!relation) return undefined;
  for (const key of relationKeys) {
    const entries = relation[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Record<string, unknown>[]) {
      const doi = extractDoi(extractString(entry.id) ?? "");
      if (doi) return doi;
    }
  }
  return undefined;
}

function extractDifferentDoi(value: string | undefined, current?: string) {
  const doi = extractDoi(value ?? "");
  return doi && doi !== current ? doi : undefined;
}

async function chemRxivSearchCandidates(input: string, env: Bindings) {
  const items = await chemRxivSearch(input, env);
  return items.slice(0, 5).map((item) => toChemRxivCandidate(item, "ChemRxiv 预印本候选"));
}

async function chemRxivSearch(input: string, env: Bindings) {
  const base = optionalEnv(env, "CHEMRXIV_API_BASE") || "https://chemrxiv.org/engage/chemrxiv/public-api/v1/items";
  const query = normalizeSearchInput(input).primary;
  if (!query) return [];
  const url = new URL(base);
  url.searchParams.set("search", query);
  url.searchParams.set("limit", "10");
    const res = await fetch(url.toString(), { headers: { "User-Agent": env.APP_USER_AGENT } }).catch(() => null);
  if (!res?.ok || !res.headers.get("Content-Type")?.toLowerCase().includes("json")) return [];
  const data = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  return readResultArray(data);
}

function toChemRxivCandidate(item: Record<string, unknown>, reason: string): PaperCandidate {
  const doi = extractDoi(findFirstStringDeep(item, ["doi", "DOI"] ) ?? "") ?? undefined;
  const publishedDoi = extractDifferentDoi(findFirstStringDeep(item, ["publishedDoi", "publishedDOI", "publishedArticleDoi", "journalArticleDoi", "versionOfRecordDoi", "articleDoi", "linkedDoi"]), doi);
  const pdfUrl = findFirstUrlDeep(item, ["pdfUrl", "pdf_url", "downloadUrl", "download_url", "assetUrl", "asset_url", "url"], true);
  const landingUrl = findFirstUrlDeep(item, ["landingUrl", "landing_page_url", "url", "doi"], false);
  return {
    id: doi ? stableId(doi) : stableId(findFirstStringDeep(item, ["id", "uuid", "slug", "title"]) ?? crypto.randomUUID()),
    doi,
    preprintDoi: doi,
    publishedDoi,
    title: findFirstStringDeep(item, ["title", "name"]) ?? "Untitled ChemRxiv preprint",
    authors: readAuthors(item),
    journal: "ChemRxiv",
    year: readYearFromUnknown(item),
    publisherUrl: landingUrl,
    source: "ChemRxiv",
    confidence: 0.68,
    matchReason: reason,
    isOa: Boolean(pdfUrl),
    oaStatus: "preprint",
    license: findFirstStringDeep(item, ["license", "licenseName", "license_name"]),
    pdfUrl,
    pdfHostType: "preprint",
    pdfSource: "ChemRxiv",
    pdfVersionType: "preprint",
    sourceUrl: landingUrl || pdfUrl
  };
}

async function oldLiteratureSearchCandidates(input: string, env: Bindings) {
  const fields = parseBibliographicHints(input);
  if (!fields.year || fields.year > 2000) return [];
  const scanCandidates = await oldLiteratureScanPdfCandidates({
    id: stableId(input),
    title: fields.title || input,
    authors: fields.author ? [fields.author] : [],
    journal: fields.journal,
    year: fields.year,
    volume: fields.volume,
    issue: fields.issue,
    pages: fields.pages,
    source: "Internet Archive",
    confidence: 0.55,
    matchReason: "旧文献公共扫描源候选",
    isOa: false
  }, env);
  return scanCandidates.slice(0, 5).map((candidate) => ({
    id: stableId(`${input}-${candidate.source}-${candidate.pdfUrl}`),
    title: fields.title || fields.journal || input,
    authors: fields.author ? [fields.author] : [],
    journal: fields.journal || candidate.source,
    year: fields.year,
    volume: fields.volume,
    issue: fields.issue,
    pages: fields.pages,
    publisherUrl: candidate.landingUrl,
    source: candidate.source || "Open Library",
    confidence: candidate.source === "Internet Archive" ? 0.62 : 0.56,
    matchReason: `${candidate.source || "开放数字图书馆"} 扫描候选；需人工确认卷期页匹配`,
    isOa: true,
    oaStatus: (fields.year ?? 9999) <= 1930 ? "public_domain_candidate" : "open_scan_candidate",
    license: candidate.license,
    pdfUrl: candidate.pdfUrl,
    pdfHostType: "repository",
    pdfSource: candidate.source,
    pdfVersionType: "repository_copy",
    sourceUrl: candidate.landingUrl || candidate.pdfUrl,
    sourceGranularity: candidate.sourceGranularity,
    derivedFrom: candidate.derivedFrom
  } satisfies PaperCandidate));
}

async function oldLiteratureScanPdfCandidates(paper: PaperCandidate, env: Bindings) {
  const year = paper.year;
  if (!year || year > 2000) return [];
  const fields = {
    title: paper.title,
    journal: normalizeJournalTitle(paper.journal || ""),
    year,
    volume: paper.volume,
    issue: paper.issue,
    pages: paper.pages,
    author: paper.authors[0]
  };
  const candidates: OpenPdfInfo[] = [];
  candidates.push(...await hathiTrustPdfCandidates(fields, env));
  if (year <= 1930) {
    candidates.push(...await internetArchivePdfCandidates(fields, env));
    candidates.push(...await biodiversityHeritagePdfCandidates(fields, env));
  } else {
    candidates.push(...await internetArchivePdfCandidates(fields, env, true));
  }
  return candidates;
}

async function internetArchivePdfCandidates(fields: BibliographicHints, env: Bindings, conservative = false) {
  const q = [
    "mediatype:texts",
    fields.year ? `year:${fields.year}` : "",
    fields.journal ? `"${fields.journal}"` : "",
    fields.volume ? `volume:${fields.volume}` : "",
    conservative ? "NOT access-restricted-item:true" : ""
  ].filter(Boolean).join(" AND ");
  const url = new URL("https://archive.org/advancedsearch.php");
  url.searchParams.set("q", q || fields.title || fields.journal || "");
  ["identifier", "title", "year", "creator", "downloads"].forEach((field) => url.searchParams.append("fl[]", field));
  url.searchParams.set("rows", "5");
  url.searchParams.set("output", "json");
  const res = await fetch(url.toString(), { headers: { "User-Agent": env.APP_USER_AGENT } }).catch(() => null);
  if (!res?.ok) return [];
  const data = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const docs = ((data.response as Record<string, unknown> | undefined)?.docs ?? []) as Record<string, unknown>[];
  const results: OpenPdfInfo[] = [];
  for (const doc of docs) {
    const identifier = extractString(doc.identifier);
    if (!identifier) continue;
    const meta = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { headers: { "User-Agent": env.APP_USER_AGENT } }).then((r) => r.ok ? r.json<Record<string, unknown>>() : null).catch(() => null);
    const openLabel = readInternetArchiveOpenLabel(meta);
    if (conservative && !openLabel) continue;
    const files = Array.isArray(meta?.files) ? meta.files as Record<string, unknown>[] : [];
    const pdf = files.find((file) => {
      const name = extractString(file.name) || "";
      const format = extractString(file.format)?.toLowerCase() || "";
      return name.toLowerCase().endsWith(".pdf") && (format.includes("pdf") || name.toLowerCase().includes("pdf"));
    });
    const name = extractString(pdf?.name);
    if (!name) continue;
    results.push(withPdfClassification({
      source: "Internet Archive",
      pdfUrl: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(name)}`,
      landingUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
      license: fields.year && fields.year <= 1930 ? "public_domain_candidate" : openLabel,
      hostType: "repository",
      version: "volume_scan",
      sourceGranularity: "volume_scan",
      derivedFrom: `internet_archive:${identifier}`
    }));
  }
  return results;
}

async function hathiTrustPdfCandidates(fields: BibliographicHints, env: Bindings) {
  const id = fields.htid
    ? { namespace: "htid", value: fields.htid }
    : fields.oclc
      ? { namespace: "oclc", value: fields.oclc }
      : fields.lccn
        ? { namespace: "lccn", value: fields.lccn }
        : null;
  if (!id) return [];

  const url = `https://catalog.hathitrust.org/api/volumes/brief/${id.namespace}/${encodeURIComponent(id.value)}.json`;
  const res = await fetch(url, { headers: { "User-Agent": env.APP_USER_AGENT } }).catch(() => null);
  if (!res?.ok) return [];
  const data = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
  return items.flatMap((item) => {
    const htid = extractString(item.htid);
    const rights = `${extractString(item.rightsCode) ?? ""} ${extractString(item.usRightsString) ?? ""}`.toLowerCase();
    const fullView = rights.includes("full view") || rights.includes("public domain") || /\bpd\b/.test(rights);
    if (!htid || !fullView) return [];
    return [withPdfClassification({
      source: "HathiTrust",
      pdfUrl: `https://babel.hathitrust.org/cgi/imgsrv/download/pdf?id=${encodeURIComponent(htid)}`,
      landingUrl: extractString(item.itemURL),
      license: extractString(item.usRightsString) || "public_domain_candidate",
      hostType: "repository",
      version: "volume_scan",
      sourceGranularity: "volume_scan",
      derivedFrom: `hathitrust:${htid}`
    })];
  });
}

function readInternetArchiveOpenLabel(meta: Record<string, unknown> | null) {
  const metadata = meta?.metadata as Record<string, unknown> | undefined;
  const joined = [
    extractString(metadata?.licenseurl),
    extractString(metadata?.rights),
    extractString(metadata?.possible_copyright_status),
    extractString(metadata?.["possible-copyright-status"]),
    extractString(metadata?.access_restricted_item),
    extractString(metadata?.["access-restricted-item"])
  ].filter(Boolean).join(" ").toLowerCase();
  if (/creative\s*commons|creativecommons|public\s*domain|no known copyright|open access|cc0|\bcc-by\b/.test(joined)) {
    return joined.includes("public domain") || joined.includes("no known copyright") ? "public_domain_candidate" : "open_license_scan";
  }
  return undefined;
}

async function biodiversityHeritagePdfCandidates(fields: BibliographicHints, env: Bindings) {
  if (!fields.journal && !fields.title) return [];
  const url = new URL("https://www.biodiversitylibrary.org/api3");
  url.searchParams.set("op", "PublicationSearchAdvanced");
  url.searchParams.set("format", "json");
  url.searchParams.set("title", fields.journal || fields.title || "");
  if (fields.year) url.searchParams.set("year", String(fields.year));
  const res = await fetch(url.toString(), { headers: { "User-Agent": env.APP_USER_AGENT } }).catch(() => null);
  if (!res?.ok) return [];
  const data = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const results = Array.isArray(data.Result) ? data.Result as Record<string, unknown>[] : [];
  return results.slice(0, 3).map((item) => {
    const itemId = extractString(item.ItemID);
    if (!itemId) return null;
    const titleId = extractString(item.TitleID) || extractString(item.BibliographyID);
    const landing = titleId ? `https://www.biodiversitylibrary.org/bibliography/${titleId}` : findFirstUrlDeep(item, ["TitleURL", "url"], false);
    return withPdfClassification({
      source: "Biodiversity Heritage Library",
      pdfUrl: `https://www.biodiversitylibrary.org/itempdf/${encodeURIComponent(itemId)}`,
      landingUrl: landing,
      license: "public_domain_candidate",
      hostType: "repository",
      version: "volume_scan",
      sourceGranularity: "volume_scan",
      derivedFrom: `bhl:${itemId}`
    });
  }).filter(Boolean) as OpenPdfInfo[];
}

function dedupeCandidates(candidates: PaperCandidate[]) {
  const byKey = new Map<string, PaperCandidate>();
  for (const candidate of candidates) {
    const key = candidate.doi || candidate.title.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    const sources = Array.from(new Set([...existing.source.split(/\s*\+\s*/), ...candidate.source.split(/\s*\+\s*/)]));
    byKey.set(key, {
      ...existing,
      ...Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined && value !== "")),
      source: sources.join(" + "),
      confidence: Math.max(existing.confidence, candidate.confidence),
      matchReason: Array.from(new Set([existing.matchReason, candidate.matchReason].filter(Boolean))).join("；"),
      isOa: existing.isOa || candidate.isOa,
      pdfUrl: existing.pdfUrl || candidate.pdfUrl,
      pdfSource: existing.pdfSource || candidate.pdfSource,
      pdfHostType: existing.pdfHostType || candidate.pdfHostType,
      pdfVersionType: existing.pdfVersionType || candidate.pdfVersionType,
      preprintDoi: existing.preprintDoi || candidate.preprintDoi,
      publishedDoi: existing.publishedDoi || candidate.publishedDoi,
      sourceGranularity: existing.sourceGranularity || candidate.sourceGranularity,
      derivedFrom: existing.derivedFrom || candidate.derivedFrom
    });
  }
  return Array.from(byKey.values());
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

async function upsertPdfCandidates(env: Bindings, paper: PaperCandidate, userId?: string) {
  const candidates = await collectPdfCandidates(paper, env, userId);
  for (const candidate of candidates) {
    await env.DB.prepare(
      "INSERT INTO paper_pdf_candidates (id, paper_id, source, pdf_url, landing_url, host_type, version, license, pdf_version_type, source_granularity, derived_from, is_publisher_version, score, verified) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET source = excluded.source, pdf_url = excluded.pdf_url, landing_url = excluded.landing_url, host_type = excluded.host_type, version = excluded.version, license = excluded.license, pdf_version_type = excluded.pdf_version_type, source_granularity = excluded.source_granularity, derived_from = excluded.derived_from, is_publisher_version = excluded.is_publisher_version, score = excluded.score"
    )
      .bind(
        candidate.id,
        paper.id,
        candidate.source ?? "unknown",
        candidate.pdfUrl,
        candidate.landingUrl ?? null,
        candidate.hostType ?? null,
        candidate.version ?? null,
        candidate.license ?? null,
        candidate.pdfVersionType ?? "unknown_version",
        candidate.sourceGranularity ?? null,
        candidate.derivedFrom ?? null,
        candidate.isPublisherVersion ? 1 : 0,
        candidate.score ?? 0,
        0
      )
      .run();
  }
  return candidates;
}

async function getPaper(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM papers WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

async function getPaperByDoi(db: D1Database, doi: string) {
  return db.prepare("SELECT * FROM papers WHERE doi = ?").bind(doi).first<Record<string, unknown>>();
}

async function listPdfCandidates(db: D1Database, paperId: string) {
  const rows = await db.prepare("SELECT * FROM paper_pdf_candidates WHERE paper_id = ? ORDER BY score DESC, datetime(created_at) ASC")
    .bind(paperId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(toPdfCandidateResponse);
}

async function listPaperFiles(db: D1Database, paperId: string, userId: string) {
  const rows = await db.prepare("SELECT * FROM paper_files WHERE paper_id = ? AND user_id = ? ORDER BY datetime(downloaded_at) DESC")
    .bind(paperId, userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    id: extractString(row.id),
    paperId: extractString(row.paper_id),
    candidateId: extractString(row.candidate_id),
    fileType: extractString(row.file_type),
    r2Key: extractString(row.r2_key),
    downloadUrl: extractString(row.r2_key) ? `/api/files?key=${encodeURIComponent(String(row.r2_key))}` : undefined,
    contentType: extractString(row.content_type),
    fileSize: typeof row.file_size === "number" ? row.file_size : Number(row.file_size) || undefined,
    contentHash: extractString(row.content_hash),
    sourceUrl: extractString(row.source_url),
    license: extractString(row.license),
    downloadedAt: extractString(row.downloaded_at)
  }));
}

function toPdfCandidateResponse(row: Record<string, unknown>) {
  return {
    id: extractString(row.id),
    paperId: extractString(row.paper_id),
    source: extractString(row.source),
    pdfUrl: extractString(row.pdf_url),
    landingUrl: extractString(row.landing_url),
    hostType: extractString(row.host_type),
    version: extractString(row.version),
    license: extractString(row.license),
    pdfVersionType: extractString(row.pdf_version_type),
    sourceGranularity: extractString(row.source_granularity),
    derivedFrom: extractString(row.derived_from),
    isPublisherVersion: row.is_publisher_version === 1,
    score: typeof row.score === "number" ? row.score : Number(row.score) || 0,
    verified: row.verified === 1,
    verificationError: extractString(row.verification_error),
    createdAt: extractString(row.created_at)
  };
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
    const files = await listPaperFiles(db, candidate.id, userId);
    const openFile = files.find((file) => file.fileType === "open_pdf");
    const citationFile = files.find((file) => file.fileType === "citation_pdf");
    const downloadRow = !openFile
      ? await db.prepare("SELECT r2_key FROM paper_downloads WHERE paper_id = ? AND user_id = ? ORDER BY datetime(created_at) DESC LIMIT 1")
        .bind(candidate.id, userId)
        .first<Record<string, unknown>>()
      : null;
    const openKey = openFile?.r2Key || extractString(downloadRow?.r2_key) || candidate.openPdfR2Key;
    const exportRow = await db.prepare("SELECT r2_key FROM citation_exports WHERE paper_id = ? AND user_id = ? ORDER BY datetime(created_at) DESC LIMIT 1")
      .bind(candidate.id, userId)
      .first<Record<string, unknown>>();
    const citationKey = citationFile?.r2Key || extractString(exportRow?.r2_key) || candidate.citationPdfR2Key;
    const pdfCandidates = await listPdfCandidates(db, candidate.id);
    const bestPdf = pdfCandidates[0];
    return {
      ...candidate,
      pdfCandidateId: bestPdf?.id || candidate.pdfCandidateId,
      pdfSource: bestPdf?.source || candidate.pdfSource,
      pdfVersionType: bestPdf?.pdfVersionType || candidate.pdfVersionType,
      sourceGranularity: bestPdf?.sourceGranularity || candidate.sourceGranularity,
      derivedFrom: bestPdf?.derivedFrom || candidate.derivedFrom,
      pdfHostType: bestPdf?.hostType || candidate.pdfHostType,
      sourceUrl: openFile?.sourceUrl || candidate.sourceUrl,
      fileSize: openFile?.fileSize,
      downloadedAt: openFile?.downloadedAt,
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
    const pdfCandidates = await upsertPdfCandidates(env, candidate, userId);
    const best = pdfCandidates[0];
    try {
      const result = await downloadVerifiedOpenPdf(env, candidate.id, candidate.doi, userId, best?.id);
      archived.push({
        ...candidate,
        pdfCandidateId: best?.id || candidate.pdfCandidateId,
        pdfSource: best?.source || candidate.pdfSource,
        pdfVersionType: best?.pdfVersionType || candidate.pdfVersionType,
        pdfHostType: best?.hostType || candidate.pdfHostType,
        license: best?.license || candidate.license,
        openPdfR2Key: result.r2Key,
        openPdfDownloadUrl: `/api/files?key=${encodeURIComponent(result.r2Key)}`,
        sourceUrl: result.sourceUrl,
        fileSize: result.fileSize,
        downloadedAt: result.downloadedAt
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
  const bytes = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf);
  const hash = await sha256Hex(bytes);
  await env.DB.prepare("INSERT INTO citation_exports (id, paper_id, user_id, format, r2_key) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), paper.id, userId, "pdf", key)
    .run();
  await env.DB.prepare("INSERT INTO paper_files (id, paper_id, candidate_id, user_id, r2_key, file_type, content_type, file_size, content_hash, source_url, license) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), paper.id, null, userId, key, "citation_pdf", "application/pdf", bytes.byteLength, hash, paper.publisherUrl ?? (paper.doi ? `https://doi.org/${paper.doi}` : null), paper.license ?? null)
    .run();
  return { r2Key: key };
}

async function downloadVerifiedOpenPdf(env: Bindings, paperId: string, doi: string | undefined, userId: string, candidateId?: string) {
  const existing = await env.DB.prepare("SELECT source_url, r2_key, license, file_size, downloaded_at FROM paper_files WHERE paper_id = ? AND user_id = ? AND file_type = ? ORDER BY datetime(downloaded_at) DESC LIMIT 1")
    .bind(paperId, userId, "open_pdf")
    .first<Record<string, unknown>>();
  const existingKey = extractString(existing?.r2_key);
  if (existingKey && await env.PAPER_BUCKET.head(existingKey)) {
    return {
      r2Key: existingKey,
      sourceUrl: extractString(existing?.source_url) ?? "",
      license: extractString(existing?.license),
      oaStatus: undefined,
      fileSize: typeof existing?.file_size === "number" ? existing.file_size : Number(existing?.file_size) || undefined,
      downloadedAt: extractString(existing?.downloaded_at)
    };
  }

  let pdfCandidate = candidateId
    ? await env.DB.prepare("SELECT * FROM paper_pdf_candidates WHERE id = ? AND paper_id = ?")
      .bind(candidateId, paperId)
      .first<Record<string, unknown>>()
    : await env.DB.prepare("SELECT * FROM paper_pdf_candidates WHERE paper_id = ? ORDER BY score DESC, datetime(created_at) ASC LIMIT 1")
      .bind(paperId)
      .first<Record<string, unknown>>();
  if (!pdfCandidate) {
    const paper = await getPaper(env.DB, paperId);
    if (paper) {
      const candidates = await upsertPdfCandidates(env, toCandidateFromRow(paper), userId);
      const best = candidateId ? candidates.find((item) => item.id === candidateId) : candidates[0];
      pdfCandidate = best ? pdfCandidateToRow(best, paperId) : null;
    }
  }
  if (!pdfCandidate) throw new Error("未找到已记录的开放 PDF 候选。没有 OA PDF 时只能导出题录 PDF。");

  const openPdf: OpenPdfInfo = {
    id: extractString(pdfCandidate.id),
    source: extractString(pdfCandidate.source),
    pdfUrl: extractString(pdfCandidate.pdf_url) ?? "",
    landingUrl: extractString(pdfCandidate.landing_url),
    license: extractString(pdfCandidate.license),
    hostType: extractString(pdfCandidate.host_type),
    version: extractString(pdfCandidate.version),
    pdfVersionType: extractString(pdfCandidate.pdf_version_type),
    sourceGranularity: extractString(pdfCandidate.source_granularity),
    derivedFrom: extractString(pdfCandidate.derived_from),
    isPublisherVersion: pdfCandidate.is_publisher_version === 1
  };
  if (!openPdf.pdfUrl) throw new Error("开放 PDF 候选缺少 URL，已阻止下载。");
  if (isBlockedPdfSource(openPdf.pdfUrl)) {
    await env.DB.prepare("UPDATE paper_pdf_candidates SET verified = 0, verification_error = ? WHERE id = ?")
      .bind("来源域名不符合合规策略，已阻止下载", extractString(pdfCandidate.id))
      .run();
    throw new Error("该 PDF 来源不符合合规策略，已阻止下载。");
  }

  const res = await fetch(openPdf.pdfUrl, { headers: pdfFetchHeaders(env, openPdf) });
  if (!res.ok) throw new Error("开放 PDF 下载失败");
  const contentType = res.headers.get("Content-Type")?.toLowerCase() ?? "";
  const buffer = await res.arrayBuffer();
  if (!isPdf(buffer)) throw new Error("下载内容不是有效 PDF，已阻止保存");
  if (contentType && !contentType.includes("pdf") && !contentType.includes("octet-stream")) {
    throw new Error("PDF 响应类型不合理，已阻止保存");
  }

  const key = `users/${userId}/papers/${paperId}/open.pdf`;
  await env.PAPER_BUCKET.put(key, buffer, { httpMetadata: { contentType: "application/pdf" } });
  const hash = await sha256Hex(buffer);
  await env.DB.prepare("UPDATE papers SET r2_pdf_key = ?, pdf_url = ?, license = ?, oa_status = ?, is_oa = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(key, openPdf.pdfUrl, openPdf.license ?? null, openPdf.oaStatus ?? null, paperId)
    .run();
  await env.DB.prepare("UPDATE paper_pdf_candidates SET verified = 1, verification_error = NULL WHERE id = ?")
    .bind(extractString(pdfCandidate.id))
    .run();
  await env.DB.prepare("INSERT INTO paper_downloads (id, paper_id, user_id, source_url, r2_key, license) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), paperId, userId, openPdf.pdfUrl, key, openPdf.license ?? null)
    .run();
  await env.DB.prepare("INSERT INTO paper_files (id, paper_id, candidate_id, user_id, r2_key, file_type, content_type, file_size, content_hash, source_url, license) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), paperId, extractString(pdfCandidate.id) ?? null, userId, key, "open_pdf", "application/pdf", buffer.byteLength, hash, openPdf.pdfUrl, openPdf.license ?? null)
    .run();

  return { r2Key: key, sourceUrl: openPdf.pdfUrl, license: openPdf.license, oaStatus: openPdf.oaStatus, fileSize: buffer.byteLength, downloadedAt: new Date().toISOString() };
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

function pdfFetchHeaders(env: Bindings, candidate: OpenPdfInfo) {
  const headers: Record<string, string> = { "User-Agent": env.APP_USER_AGENT };
  const coreKey = optionalEnv(env, "CORE_API_KEY");
  if (candidate.source === "CORE" && coreKey) headers.Authorization = `Bearer ${coreKey}`;
  return headers;
}

function optionalEnv(env: Bindings, key: string) {
  const values = env as unknown as Record<string, string | undefined>;
  return values[key]?.trim();
}

function isBlockedPdfSource(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return [
      "sci-hub",
      "scihub",
      "libgen",
      "z-library",
      "zlibrary"
    ].some((blocked) => host.includes(blocked));
  } catch {
    return true;
  }
}

function pdfCandidateToRow(candidate: OpenPdfInfo, paperId: string): Record<string, unknown> {
  return {
    id: candidate.id,
    paper_id: paperId,
    source: candidate.source,
    pdf_url: candidate.pdfUrl,
    landing_url: candidate.landingUrl,
    host_type: candidate.hostType,
    version: candidate.version,
    license: candidate.license,
    pdf_version_type: candidate.pdfVersionType,
    source_granularity: candidate.sourceGranularity,
    derived_from: candidate.derivedFrom,
    is_publisher_version: candidate.isPublisherVersion ? 1 : 0,
    score: candidate.score ?? 0
  };
}

async function sha256Hex(input: ArrayBuffer | Uint8Array) {
  const buffer = input instanceof Uint8Array
    ? new Uint8Array(input).buffer
    : input;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
