import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as React from "react";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileArchive,
  FileText,
  History,
  Home,
  Image,
  LogOut,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud
} from "lucide-react";
import "./styles.css";

type Config = {
  appId: string;
  authCenterUrl: string;
  callbackPath: string;
};

type User = {
  uuid: string;
  name?: string;
  username?: string;
  email?: string;
  role?: string;
  avatar_url?: string;
};

type QuotaSnapshot = {
  ok?: boolean;
  status?: number;
  message?: string;
  data?: unknown;
};

type SiteSettings = {
  landingBackgroundUrl?: string;
  landingBackgroundOpacity: number;
  updatedAt?: string;
};

type Candidate = {
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

type BatchItem = {
  input: string;
  status: string;
  message?: string;
  candidates: Candidate[];
};

type LookupResponse = {
  queued?: boolean;
  taskId?: string;
  status?: string;
  inputType: string;
  candidates: Candidate[];
};

type TaskResponse = {
  task: {
    id: string;
    status: string;
    input_type?: string;
    result: {
      inputType?: string;
      candidates?: Candidate[];
      message?: string;
    } | BatchItem[];
  };
};

type HistoryItem = {
  id: string;
  inputText: string;
  inputType: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  summary: string;
  candidateCount: number;
  candidates: Candidate[];
};

type HistoryRecord = HistoryItem & {
  candidates: Candidate[];
};

type CandidateFiles = {
  openKey?: string;
  openUrl?: string;
  citationKey?: string;
  citationUrl?: string;
};

const storage = {
  get token() {
    return localStorage.getItem("sso_token") || "";
  },
  set token(value: string) {
    localStorage.setItem("sso_token", value);
  },
  clear() {
    localStorage.removeItem("sso_token");
    localStorage.removeItem("user_profile");
  },
  get user(): User | null {
    const raw = localStorage.getItem("user_profile");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  set user(value: User) {
    localStorage.setItem("user_profile", JSON.stringify(value));
  }
};

function App() {
  const [config, setConfig] = React.useState<Config | null>(null);
  const [user, setUser] = React.useState<User | null>(storage.user);
  const [quota, setQuota] = React.useState<QuotaSnapshot | null>(null);
  const [siteSettings, setSiteSettings] = React.useState<SiteSettings>({ landingBackgroundOpacity: 0.28 });
  const [bootMessage, setBootMessage] = React.useState("正在连接 ChemPaper Finder");

  React.useEffect(() => {
    api<Config>("/api/config", { auth: false })
      .then(setConfig)
      .catch(() => setBootMessage("无法读取应用配置，请稍后刷新"));
    api<{ settings: SiteSettings }>("/api/site-settings", { auth: false })
      .then((data) => setSiteSettings(data.settings))
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--landing-bg-image", siteSettings.landingBackgroundUrl ? `url("${siteSettings.landingBackgroundUrl}")` : "none");
    root.style.setProperty("--landing-bg-opacity", String(siteSettings.landingBackgroundOpacity ?? 0.28));
  }, [siteSettings]);

  React.useEffect(() => {
    if (!config) return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (window.location.pathname === "/sso-callback" && token) {
      setBootMessage("正在验证 Auth Center 登录状态");
      api<{ success: boolean; user: User; token: string; quota?: QuotaSnapshot }>("/api/sso-callback", {
        auth: false,
        method: "POST",
        body: { token }
      })
        .then((data) => {
          storage.token = data.token;
          storage.user = data.user;
          setUser(data.user);
          setQuota(data.quota ?? null);
          const next = sessionStorage.getItem("post_login_path") || "/";
          sessionStorage.removeItem("post_login_path");
          window.history.replaceState({}, "", next);
          void track("page_view", data.user.uuid);
        })
        .catch((error) => setBootMessage(error.message));
    }
  }, [config]);

  React.useEffect(() => {
    if (!config) return;
    const handleExpired = () => {
      storage.clear();
      setUser(null);
      redirectToAuthCenter(config);
    };
    window.addEventListener("auth-expired", handleExpired);
    return () => window.removeEventListener("auth-expired", handleExpired);
  }, [config]);

  React.useEffect(() => {
    if (!config || !storage.token || !storage.user || window.location.pathname === "/sso-callback") return;
    api<{ success: boolean; user: User; quota?: QuotaSnapshot }>("/api/me")
      .then((data) => {
        storage.user = data.user;
        setUser(data.user);
        setQuota(data.quota ?? null);
      })
      .catch((error) => setBootMessage(error instanceof Error ? error.message : "无法刷新登录与额度信息"));
  }, [config]);

  if (!config) {
    return (
      <>
        <GlobalBackground />
        <BootScreen message={bootMessage} />
      </>
    );
  }

  if (!user || !storage.token) {
    return (
      <>
        <GlobalBackground />
        <LoginScreen config={config} message={bootMessage} />
      </>
    );
  }

  if (window.location.pathname === "/history") {
    return (
      <>
        <GlobalBackground />
        <HistoryPage config={config} user={user} />
      </>
    );
  }

  const historyMatch = window.location.pathname.match(/^\/history\/([^/]+)$/);
  if (historyMatch) {
    return (
      <>
        <GlobalBackground />
        <HistoryDetailPage config={config} user={user} recordId={historyMatch[1]} />
      </>
    );
  }

  if (window.location.pathname === "/admin") {
    return (
      <>
        <GlobalBackground />
        <AdminPage config={config} user={user} settings={siteSettings} onSettingsChange={setSiteSettings} />
      </>
    );
  }

  return (
    <>
      <GlobalBackground />
      <Dashboard config={config} user={user} quota={quota} onUserChange={setUser} />
    </>
  );
}

function GlobalBackground() {
  return <div className="global-bg" aria-hidden="true" />;
}

function BootScreen({ message }: { message: string }) {
  return (
    <main className="boot">
      <div className="brand-mark"><Sparkles size={24} /></div>
      <p>{message}</p>
    </main>
  );
}

function LoginScreen({ config, message }: { config: Config; message: string }) {
  const login = () => {
    redirectToAuthCenter(config);
  };

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-row">
          <div className="brand-mark"><BookOpen size={26} /></div>
          <span>ChemPaper Finder</span>
        </div>
        <h1>查找化学文献，下载合法开放 PDF</h1>
        <p>{message === "正在连接 ChemPaper Finder" ? "请通过 Auth Center 登录后使用检索、下载和导出功能。" : message}</p>
        <button type="button" className="primary-action" onClick={login}>
          <ShieldCheck size={18} />
          使用 Auth Center 登录
        </button>
      </section>
    </main>
  );
}

function redirectToAuthCenter(config: Config) {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current !== config.callbackPath) sessionStorage.setItem("post_login_path", current || "/");
  const redirect = `${window.location.origin}${config.callbackPath}`;
  window.location.href = `${config.authCenterUrl}/?client_id=${encodeURIComponent(config.appId)}&redirect=${encodeURIComponent(redirect)}`;
}

function Dashboard({ config, user, quota, onUserChange }: { config: Config; user: User; quota: QuotaSnapshot | null; onUserChange: (user: User | null) => void }) {
  const [input, setInput] = React.useState("");
  const [mode, setMode] = React.useState<"auto" | "doi" | "citation" | "fuzzy">("auto");
  const [candidates, setCandidates] = React.useState<Candidate[]>([]);
  const [selected, setSelected] = React.useState<Candidate | null>(null);
  const [batchInput, setBatchInput] = React.useState("");
  const [batchTaskId, setBatchTaskId] = React.useState("");
  const [batchItems, setBatchItems] = React.useState<BatchItem[]>([]);
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const [activeTaskId, setActiveTaskId] = React.useState("");
  const [profileOpen, setProfileOpen] = React.useState(false);
  const profileRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    void track("page_view", user.uuid);
  }, [user.uuid]);

  React.useEffect(() => {
    if (!profileOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!profileRef.current?.contains(event.target as Node)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [profileOpen]);

  const pollLookupTask = async (taskId: string) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await delay(attempt < 8 ? 900 : 1500);
      const data = await api<TaskResponse>(`/api/tasks/${taskId}`);
      const result = Array.isArray(data.task.result) ? { candidates: [] } : data.task.result;
      if (data.task.status === "completed") {
        const nextCandidates = result.candidates ?? [];
        setCandidates(nextCandidates);
        setSelected(nextCandidates[0] ?? null);
        setNotice(nextCandidates.length ? `检索完成：返回 ${nextCandidates.length} 个候选，请确认最符合的一条。` : "检索完成，但未找到候选，请尝试补充作者、期刊、年份或 DOI。");
        return;
      }
      if (data.task.status === "failed") {
        throw new Error(result.message || "检索任务失败，请稍后重试。");
      }
      setNotice(data.task.status === "running" ? "正在检索 Crossref / OpenAlex / Unpaywall，请稍候。" : "任务已进入队列，正在等待检索。");
    }
    throw new Error("检索仍在后台进行，请稍后刷新任务结果。");
  };

  const lookup = async () => {
    setNotice("");
    if (!input.trim()) {
      setNotice("请输入 DOI、题录或作者/期刊/年份/关键词。");
      return;
    }
    setBusy("lookup");
    try {
      setCandidates([]);
      setSelected(null);
      const data = await api<LookupResponse>("/api/papers/lookup", {
        method: "POST",
        body: { input, mode }
      });
      if (data.queued && data.taskId) {
        setActiveTaskId(data.taskId);
        setNotice("任务已进入检索队列，后台正在处理。");
        await pollLookupTask(data.taskId);
      } else {
        setCandidates(data.candidates);
        setSelected(data.candidates[0] ?? null);
        setNotice(data.candidates.length ? `已返回 ${data.candidates.length} 个候选，${data.inputType === "doi" ? "DOI 已精确匹配" : "请确认最符合的一条"}` : "未找到候选，请尝试补充作者、期刊、年份或 DOI。");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "检索失败");
    } finally {
      setBusy("");
      setActiveTaskId("");
    }
  };

  const runBatch = async () => {
    setNotice("");
    if (!batchInput.trim()) {
      setNotice("请在批量框中每行输入一条参考文献。");
      return;
    }
    setBusy("batch");
    try {
      const data = await api<{ taskId: string; items: BatchItem[] }>("/api/batch/lookup", {
        method: "POST",
        body: { input: batchInput, mode: "auto" }
      });
      setBatchTaskId(data.taskId);
      setBatchItems(data.items);
      setNotice(`批量任务完成：${data.items.length} 条输入已处理。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "批量检索失败");
    } finally {
      setBusy("");
    }
  };

  const signOut = async () => {
    await api("/api/signout", { method: "POST" }).catch(() => undefined);
    storage.clear();
    onUserChange(null);
    window.location.href = `${config.authCenterUrl}/logout?redirect=${encodeURIComponent(window.location.origin)}`;
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-row">
          <div className="brand-mark"><BookOpen size={24} /></div>
          <div>
            <strong>ChemPaper Finder</strong>
            <span>Open-access chemistry paper retrieval</span>
          </div>
        </div>
        <a className="secondary-action nav-action" href="/history">
          <History size={16} />
          历史
        </a>
        {isAdminUser(user) && (
          <a className="secondary-action nav-action compact" href="/admin">
            <Settings size={16} />
            Admin
          </a>
        )}
        <div className="profile-menu" ref={profileRef}>
          <button type="button" className="avatar-button" onClick={() => setProfileOpen((open) => !open)} title="用户信息">
            <Avatar config={config} user={user} />
          </button>
          {profileOpen && (
            <div className="profile-popover">
              <div className="profile-head">
                <Avatar config={config} user={user} />
                <div>
                  <strong>{user.name || user.username || "已登录用户"}</strong>
                  <span>{user.email || user.username || "Auth Center 用户"}</span>
                </div>
              </div>
              <dl>
                <div><dt>UUID</dt><dd>{user.uuid}</dd></div>
                <div><dt>身份</dt><dd>{user.role || "user"}</dd></div>
                <div><dt>额度</dt><dd>{quotaSummary(quota)}</dd></div>
              </dl>
              <div className="profile-actions">
                <a className="secondary-action" href={`${config.authCenterUrl}/${user.uuid}`}>
                  <ExternalLink size={16} />
                  用户详情
                </a>
                <button type="button" className="icon-button labeled" onClick={signOut}>
                  <LogOut size={16} />
                  退出
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      <section className="workspace">
        <section className="search-band">
          <div className="search-copy">
            <p className="eyebrow"><ShieldCheck size={15} /> 只下载合法开放获取 PDF，不绕过付费墙</p>
            <h1>从 DOI、题录或模糊线索找到可信文献</h1>
          </div>
          <div className="search-tool">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="例如：10.1021/acs.joc.xxxxxxx&#10;或 J. Am. Chem. Soc. 2020, 142, 15, 6789-6798"
            />
            <div className="tool-row">
              <div className="segmented" aria-label="输入模式">
                {[
                  ["auto", "自动"],
                  ["doi", "DOI"],
                  ["citation", "题录"],
                  ["fuzzy", "模糊"]
                ].map(([value, label]) => (
                  <button type="button" key={value} className={mode === value ? "active" : ""} onClick={() => setMode(value as typeof mode)}>{label}</button>
                ))}
              </div>
              <button type="button" className="primary-action" onClick={lookup} disabled={busy === "lookup"}>
                <Search size={18} />
                {busy === "lookup" ? (activeTaskId ? "队列检索中" : "提交中") : "开始检索"}
              </button>
            </div>
          </div>
        </section>

        {notice && <div className="notice">{notice}</div>}

        <section className="content-grid">
          <section className="results-panel">
            <div className="section-title">
              <h2>候选结果</h2>
              <span>{candidates.length ? `${candidates.length} 条` : "等待检索"}</span>
            </div>
            <div className="result-list">
              {candidates.map((candidate) => (
                <ResultCard
                  key={candidate.id}
                  candidate={candidate}
                  selected={selected?.id === candidate.id}
                  onSelect={() => setSelected(candidate)}
                />
              ))}
              {!candidates.length && <EmptyState text="输入 DOI 或题录后，这里会显示来自 Crossref / OpenAlex / Unpaywall 的实时结果。" />}
            </div>
          </section>

          <DetailPanel candidate={selected} setNotice={setNotice} />
        </section>

        <section className="batch-panel">
          <div className="section-title">
            <h2>批量任务</h2>
            <span>最多 20 行同步处理</span>
          </div>
          <div className="batch-layout">
            <textarea
              value={batchInput}
              onChange={(event) => setBatchInput(event.target.value)}
              placeholder="每行一条参考文献或 DOI"
            />
            <div className="batch-actions">
              <button type="button" className="secondary-action" onClick={runBatch} disabled={busy === "batch"}>
                <FileText size={17} />
                {busy === "batch" ? "处理中" : "批量检索"}
              </button>
              <ExportButton taskId={batchTaskId} format="csv" icon={<Download size={17} />} label="CSV" />
              <ExportButton taskId={batchTaskId} format="bibtex" icon={<Copy size={17} />} label="BibTeX" />
              <ExportButton taskId={batchTaskId} format="citation-zip" icon={<FileArchive size={17} />} label="题录 ZIP" json />
            </div>
          </div>
          <div className="batch-results">
            {batchItems.map((item, index) => (
              <div className="batch-row" key={`${item.input}-${index}`}>
                <span className={`status ${item.status}`}>{statusText(item.status)}</span>
                <p>{item.input}</p>
                <small>{item.candidates[0]?.title || item.message || "无候选"}</small>
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function AdminPage({ user, settings, onSettingsChange }: { config: Config; user: User; settings: SiteSettings; onSettingsChange: (settings: SiteSettings) => void }) {
  const [localOpacity, setLocalOpacity] = React.useState(settings.landingBackgroundOpacity ?? 0.28);
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setLocalOpacity(settings.landingBackgroundOpacity ?? 0.28);
  }, [settings.landingBackgroundOpacity]);

  if (!isAdminUser(user)) {
    return (
      <main className="app-shell">
        <header className="topbar">
          <div className="brand-row">
            <div className="brand-mark"><ShieldCheck size={24} /></div>
            <div>
              <strong>Admin Dash</strong>
              <span>权限校验</span>
            </div>
          </div>
          <a className="secondary-action nav-action" href="/"><Home size={16} /> 返回主页</a>
        </header>
        <section className="workspace admin-workspace">
          <section className="admin-panel">
            <EmptyState text="当前账号没有管理权限。请使用 Auth Center 中具备 admin / owner / super_admin 身份的账号登录。" />
          </section>
        </section>
      </main>
    );
  }

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy("upload");
    try {
      const data = await uploadLandingBackground(file, localOpacity);
      onSettingsChange(data.settings);
      setNotice("落地页背景已上传并生效。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "上传失败");
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const saveOpacity = async () => {
    setBusy("opacity");
    try {
      const data = await api<{ settings: SiteSettings }>("/api/admin/site-settings", {
        method: "PATCH",
        body: { landingBackgroundOpacity: localOpacity }
      });
      onSettingsChange(data.settings);
      setNotice("背景透明度已更新。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "透明度保存失败");
    } finally {
      setBusy("");
    }
  };

  const reset = async () => {
    setBusy("delete");
    try {
      const data = await api<{ settings: SiteSettings }>("/api/admin/landing-background", { method: "DELETE" });
      onSettingsChange(data.settings);
      setNotice("已删除自定义背景并恢复默认。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-row">
          <div className="brand-mark"><Settings size={24} /></div>
          <div>
            <strong>Admin Dash</strong>
            <span>Landing visual controls</span>
          </div>
        </div>
        <a className="secondary-action nav-action" href="/"><Home size={16} /> 返回主页</a>
      </header>

      <section className="workspace admin-workspace">
        <section className="admin-hero">
          <p className="eyebrow"><Image size={15} /> 页面风格</p>
          <h1>管理落地页背景与视觉透明度</h1>
          <p>上传一张干净的大图作为背景，调节透明度，让工作台保持简约、清晰，同时有足够的品牌感。</p>
        </section>

        {notice && <div className="notice">{notice}</div>}

        <section className="admin-layout">
          <div className="admin-preview">
            <div className="preview-surface">
              <div className="preview-copy">
                <span>ChemPaper Finder</span>
                <strong>从 DOI、题录或模糊线索找到可信文献</strong>
                <small>当前透明度 {Math.round(localOpacity * 100)}%</small>
              </div>
            </div>
          </div>

          <div className="admin-panel">
            <div className="section-title">
              <h2>背景设置</h2>
              <span>{settings.landingBackgroundUrl ? "自定义图片已启用" : "默认背景"}</span>
            </div>
            <div className="admin-controls">
              <label className="upload-drop">
                <UploadCloud size={22} />
                <span>{busy === "upload" ? "上传中" : "上传背景图片"}</span>
                <small>JPG、PNG、WebP、GIF，最大 5MB</small>
                <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={upload} disabled={Boolean(busy)} />
              </label>

              <label className="range-field">
                <span>背景透明度</span>
                <input type="range" min="0" max="0.82" step="0.01" value={localOpacity} onChange={(event) => setLocalOpacity(Number(event.target.value))} />
                <strong>{Math.round(localOpacity * 100)}%</strong>
              </label>

              <div className="admin-actions">
                <button type="button" className="primary-action" onClick={saveOpacity} disabled={busy === "opacity"}>
                  <CheckCircle2 size={17} />
                  {busy === "opacity" ? "保存中" : "保存透明度"}
                </button>
                <button type="button" className="secondary-action danger-action" onClick={reset} disabled={busy === "delete" || !settings.landingBackgroundUrl}>
                  <RotateCcw size={17} />
                  恢复默认
                </button>
              </div>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function HistoryPage({ config, user }: { config: Config; user: User }) {
  const [items, setItems] = React.useState<HistoryItem[]>([]);
  const [notice, setNotice] = React.useState("");

  React.useEffect(() => {
    api<{ items: HistoryItem[] }>("/api/history")
      .then((data) => {
        setItems(data.items);
        setNotice(data.items.length ? "" : "还没有查询记录。");
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : "历史记录加载失败"));
  }, []);

  const deleteRecord = async (id: string) => {
    await api(`/api/history/${id}`, { method: "DELETE" });
    setItems((current) => current.filter((item) => item.id !== id));
  };

  return (
    <main className="app-shell">
      <SimpleHeader title="查询历史" subtitle={user.name || user.username || user.uuid} />
      <section className="workspace history-workspace">
        <div className="history-toolbar">
          <a className="secondary-action" href="/">
            <Home size={16} />
            返回主页
          </a>
        </div>
        {notice && <div className="notice">{notice}</div>}
        <div className="history-list">
          {items.map((item) => (
            <article className="history-card" key={item.id}>
              <div>
                <div className="history-meta">
                  <span>#{item.id}</span>
                  <span>{formatDate(item.createdAt)}</span>
                  <span>{item.status}</span>
                </div>
                <h2>{item.summary}</h2>
                <p>{item.inputText}</p>
                <small>{item.candidateCount} 个相似结果 · {item.inputType}</small>
              </div>
              <div className="history-card-actions">
                <a className="primary-action" href={`/history/${item.id}`}>
                  查看详情
                  <ArrowRight size={16} />
                </a>
                <button type="button" className="icon-button" title="删除整条记录" onClick={() => void deleteRecord(item.id)}>
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function HistoryDetailPage({ config, recordId }: { config: Config; user: User; recordId: string }) {
  const [record, setRecord] = React.useState<HistoryRecord | null>(null);
  const [selected, setSelected] = React.useState<Candidate | null>(null);
  const [notice, setNotice] = React.useState("");

  const load = React.useCallback(() => {
    api<{ record: HistoryRecord }>(`/api/history/${recordId}`)
      .then((data) => {
        setRecord(data.record);
        setSelected(data.record.candidates[0] ?? null);
        setNotice("");
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : "查询详情加载失败"));
  }, [recordId]);

  React.useEffect(() => {
    load();
  }, [load]);

  const deleteCandidate = async (candidate: Candidate) => {
    await api<{ candidates: Candidate[] }>(`/api/history/${recordId}/candidates/${encodeURIComponent(candidate.id)}`, { method: "DELETE" });
    load();
  };

  return (
    <main className="app-shell">
      <SimpleHeader title="历史详情" subtitle={`#${recordId}`} />
      <section className="workspace history-workspace">
        <div className="history-toolbar">
          <a className="secondary-action" href="/">
            <Home size={16} />
            返回主页
          </a>
          <a className="secondary-action" href="/history">
            <History size={16} />
            历史列表
          </a>
        </div>
        {notice && <div className="notice">{notice}</div>}
        {record && (
          <>
            <section className="history-summary">
              <div>
                <span>查询编号</span>
                <strong>{record.id}</strong>
              </div>
              <div>
                <span>查询时间</span>
                <strong>{formatDate(record.createdAt)}</strong>
              </div>
              <div>
                <span>概要</span>
                <strong>{record.summary}</strong>
              </div>
            </section>
            <section className="content-grid">
              <section className="results-panel">
                <div className="section-title">
                  <h2>相似结果</h2>
                  <span>{record.candidates.length} 条</span>
                </div>
                <div className="result-list">
                  {record.candidates.map((candidate) => (
                    <article className={`result-card ${selected?.id === candidate.id ? "selected" : ""}`} key={candidate.id}>
                      <div className="result-head">
                        <span className="source-pill">{candidate.source}</span>
                        <span className={`oa-pill ${candidate.isOa ? "oa" : "closed"}`}>{candidate.isOa ? "开放 PDF" : "仅题录"}</span>
                      </div>
                      <h3>{candidate.title}</h3>
                      <p>{candidate.authors.join(", ") || "作者未知"}</p>
                      <div className="history-card-actions inline">
                        <button type="button" className="select-button" onClick={() => setSelected(candidate)}>
                          查看
                          <ArrowRight size={16} />
                        </button>
                        <button type="button" className="icon-button" title="删除该相似结果" onClick={() => void deleteCandidate(candidate)}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
                  {!record.candidates.length && <EmptyState text="这条查询记录中没有相似结果。" />}
                </div>
              </section>
              <HistoryCandidateDetail candidate={selected} setNotice={setNotice} />
            </section>
          </>
        )}
      </section>
    </main>
  );
}

function HistoryCandidateDetail({ candidate, setNotice }: { candidate: Candidate | null; setNotice: (value: string) => void }) {
  const [busy, setBusy] = React.useState("");
  const [files, setFiles] = useCandidateFiles(candidate);

  if (!candidate) {
    return (
      <section className="detail-panel">
        <EmptyState text="选择一个相似结果查看题目、作者、链接和 PDF 文件。" />
      </section>
    );
  }

  const exportCitation = async () => {
    if (files.citationUrl) {
      await downloadFile(files.citationUrl, fileNameForCandidate(candidate, "citation"));
      return;
    }
    setBusy("citation");
    try {
      const data = await api<{ r2Key: string; downloadUrl: string }>("/api/papers/export-citation-pdf", {
        method: "POST",
        body: { paperId: candidate.id, candidateId: candidate.pdfCandidateId }
      });
      setFiles((current) => ({ ...current, citationKey: data.r2Key, citationUrl: data.downloadUrl }));
      setNotice("题录 PDF 已生成并保存到 R2。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "题录 PDF 生成失败");
    } finally {
      setBusy("");
    }
  };

  const downloadOpenPdf = async () => {
    if (files.openUrl) {
      await downloadFile(files.openUrl, fileNameForCandidate(candidate, "open"));
      return;
    }
    setBusy("download");
    try {
      const data = await api<{ r2Key: string; downloadUrl: string; sourceUrl: string }>("/api/papers/download-open-pdf", {
        method: "POST",
        body: { paperId: candidate.id }
      });
      setFiles((current) => ({ ...current, openKey: data.r2Key, openUrl: data.downloadUrl }));
      setNotice(`开放 PDF 已保存到 R2，来源：${data.sourceUrl}`);
      await downloadFile(data.downloadUrl, fileNameForCandidate(candidate, "open"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "开放 PDF 下载失败");
    } finally {
      setBusy("");
    }
  };

  const deleteFile = async (kind: "open" | "citation") => {
    const key = kind === "open" ? files.openKey : files.citationKey;
    if (!key) return;
    setBusy(kind === "open" ? "delete-open" : "delete-citation");
    try {
      await api("/api/files", { method: "DELETE", body: { key } });
      setFiles((current) => kind === "open"
        ? { ...current, openKey: undefined, openUrl: undefined }
        : { ...current, citationKey: undefined, citationUrl: undefined });
      setNotice(kind === "open" ? "开放 PDF 文件已删除。" : "题录 PDF 文件已删除。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "文件删除失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="detail-panel">
      <div className="section-title">
        <h2>文献详情</h2>
        <span>{candidate.doi || "无 DOI"}</span>
      </div>
      <h3>{candidate.title}</h3>
      <dl>
        <div><dt>作者</dt><dd>{candidate.authors.join(", ") || "未知"}</dd></div>
        <div><dt>时间</dt><dd>{candidate.year || "未知"}</dd></div>
        <div><dt>期刊</dt><dd>{candidate.journal || "未知"}</dd></div>
        <div><dt>卷期页</dt><dd>{[candidate.volume, candidate.issue, candidate.pages].filter(Boolean).join(" / ") || "未知"}</dd></div>
        {candidate.preprintDoi && <div><dt>预印本 DOI</dt><dd>{candidate.preprintDoi}</dd></div>}
        {candidate.publishedDoi && <div><dt>正式论文 DOI</dt><dd>{candidate.publishedDoi}</dd></div>}
        <div><dt>链接</dt><dd>{candidate.publisherUrl || candidate.doi ? <a href={candidate.publisherUrl || `https://doi.org/${candidate.doi}`} target="_blank" rel="noreferrer">打开来源</a> : "未知"}</dd></div>
        <div><dt>开放 PDF</dt><dd>{files.openUrl ? "已保存到 R2" : candidate.isOa ? "可获取，尚未保存或保存失败" : "未找到合法开放 PDF"}</dd></div>
        <div><dt>PDF 来源</dt><dd>{[candidate.pdfSource, candidate.pdfHostType].filter(Boolean).join(" · ") || "无"}</dd></div>
        <div><dt>版本类型</dt><dd>{versionLabel(candidate.pdfVersionType)}</dd></div>
        <div><dt>来源粒度</dt><dd>{granularityLabel(candidate.sourceGranularity, candidate.derivedFrom)}</dd></div>
        <div><dt>许可证</dt><dd>{candidate.license || "未注明"}</dd></div>
        <div><dt>保存信息</dt><dd>{candidate.fileSize ? `${formatBytes(candidate.fileSize)} · ${formatDate(candidate.downloadedAt)}` : "尚未保存开放 PDF"}</dd></div>
        <div><dt>题录 PDF</dt><dd>{files.citationUrl ? "已保存到 R2" : candidate.isOa ? "可手动生成" : "正在自动生成或尚未生成"}</dd></div>
      </dl>
      <div className="detail-actions">
        {candidate.isOa && (
          <button type="button" className="primary-action" onClick={() => void downloadOpenPdf()} disabled={busy === "download"}>
            <Download size={17} />
            {files.openUrl ? "下载开放 PDF" : busy === "download" ? "保存中" : "保存并下载开放 PDF"}
          </button>
        )}
        {files.openKey && (
          <button type="button" className="icon-button labeled danger-action" onClick={() => void deleteFile("open")} disabled={busy === "delete-open"}>
            <Trash2 size={16} />
            删除开放 PDF
          </button>
        )}
        <button type="button" className="secondary-action" onClick={() => void exportCitation()} disabled={busy === "citation"}>
          <FileText size={17} />
          {files.citationUrl ? "下载题录 PDF" : busy === "citation" ? "生成中" : "生成题录 PDF"}
        </button>
        {files.citationKey && (
          <button type="button" className="icon-button labeled danger-action" onClick={() => void deleteFile("citation")} disabled={busy === "delete-citation"}>
            <Trash2 size={16} />
            删除题录 PDF
          </button>
        )}
      </div>
    </section>
  );
}

function SimpleHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="topbar">
      <div className="brand-row">
        <div className="brand-mark"><BookOpen size={24} /></div>
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
      </div>
    </header>
  );
}

function ResultCard({ candidate, selected, onSelect }: { candidate: Candidate; selected: boolean; onSelect: () => void }) {
  return (
    <article className={`result-card ${selected ? "selected" : ""}`}>
      <div className="result-head">
        <span className="source-pill">{candidate.source}</span>
        <span className={`oa-pill ${candidate.isOa ? "oa" : "closed"}`}>{candidate.isOa ? "开放 PDF 可查" : "仅题录导出"}</span>
      </div>
      <h3>{candidate.title}</h3>
      <p>{candidate.authors.slice(0, 4).join(", ") || "作者未知"}</p>
      <div className="meta-line">
        <span>{candidate.journal || "期刊未知"}</span>
        <span>{candidate.year || "年份未知"}</span>
        <span>{Math.round(candidate.confidence * 100)}%</span>
      </div>
      <p className="reason">{candidate.matchReason}</p>
      <button type="button" className="select-button" onClick={onSelect}>
        选择此文献
        <ArrowRight size={16} />
      </button>
    </article>
  );
}

function DetailPanel({ candidate, setNotice }: { candidate: Candidate | null; setNotice: (value: string) => void }) {
  const [busy, setBusy] = React.useState("");
  const [files, setFiles] = useCandidateFiles(candidate);

  if (!candidate) {
    return (
      <section className="detail-panel">
        <EmptyState text="选择候选后，可以检查 DOI、OA 状态、复制引用并导出 PDF。" />
      </section>
    );
  }

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(`${label} 已复制。`);
  };

  const exportCitation = async () => {
    if (files.citationUrl) {
      await downloadFile(files.citationUrl, fileNameForCandidate(candidate, "citation"));
      return;
    }
    setBusy("citation");
    try {
      const data = await api<{ r2Key: string; downloadUrl: string }>("/api/papers/export-citation-pdf", {
        method: "POST",
        body: { paperId: candidate.id, candidateId: candidate.pdfCandidateId }
      });
      setFiles((current) => ({ ...current, citationKey: data.r2Key, citationUrl: data.downloadUrl }));
      setNotice("题录 PDF 已生成并保存到 R2。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "题录 PDF 导出失败");
    } finally {
      setBusy("");
    }
  };

  const downloadOpenPdf = async () => {
    if (files.openUrl) {
      await downloadFile(files.openUrl, fileNameForCandidate(candidate, "open"));
      return;
    }
    setBusy("download");
    try {
      const data = await api<{ r2Key: string; downloadUrl: string; sourceUrl: string }>("/api/papers/download-open-pdf", {
        method: "POST",
        body: { paperId: candidate.id }
      });
      setFiles((current) => ({ ...current, openKey: data.r2Key, openUrl: data.downloadUrl }));
      setNotice(`开放 PDF 已保存，来源：${data.sourceUrl}`);
      await downloadFile(data.downloadUrl, fileNameForCandidate(candidate, "open"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "开放 PDF 下载失败");
    } finally {
      setBusy("");
    }
  };

  const deleteFile = async (kind: "open" | "citation") => {
    const key = kind === "open" ? files.openKey : files.citationKey;
    if (!key) return;
    setBusy(kind === "open" ? "delete-open" : "delete-citation");
    try {
      await api("/api/files", { method: "DELETE", body: { key } });
      setFiles((current) => kind === "open"
        ? { ...current, openKey: undefined, openUrl: undefined }
        : { ...current, citationKey: undefined, citationUrl: undefined });
      setNotice(kind === "open" ? "开放 PDF 文件已删除。" : "题录 PDF 文件已删除。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "文件删除失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="detail-panel">
      <div className="section-title">
        <h2>文献详情</h2>
        <span>{candidate.doi || "无 DOI"}</span>
      </div>
      <h3>{candidate.title}</h3>
      <dl>
        <div><dt>作者</dt><dd>{candidate.authors.join(", ") || "未知"}</dd></div>
        <div><dt>期刊</dt><dd>{candidate.journal || "未知"}</dd></div>
        <div><dt>年份 / 卷期页</dt><dd>{[candidate.year, candidate.volume, candidate.issue, candidate.pages].filter(Boolean).join(" / ") || "未知"}</dd></div>
        {candidate.preprintDoi && <div><dt>预印本 DOI</dt><dd>{candidate.preprintDoi}</dd></div>}
        {candidate.publishedDoi && <div><dt>正式论文 DOI</dt><dd>{candidate.publishedDoi}</dd></div>}
        <div><dt>OA 状态</dt><dd>{candidate.isOa ? `${candidate.oaStatus || "open"} · ${candidate.license || "license 未注明"}` : "未找到合法开放 PDF"}</dd></div>
        <div><dt>PDF 来源</dt><dd>{[candidate.pdfSource, candidate.pdfHostType].filter(Boolean).join(" · ") || (candidate.isOa ? "已记录开放来源" : "无")}</dd></div>
        <div><dt>版本类型</dt><dd>{versionLabel(candidate.pdfVersionType)}</dd></div>
        <div><dt>来源粒度</dt><dd>{granularityLabel(candidate.sourceGranularity, candidate.derivedFrom)}</dd></div>
        <div><dt>保存信息</dt><dd>{candidate.fileSize ? `${formatBytes(candidate.fileSize)} · ${formatDate(candidate.downloadedAt)}` : "尚未保存开放 PDF"}</dd></div>
      </dl>
      <div className="detail-actions">
        {candidate.isOa && (
          <button type="button" className="primary-action" onClick={downloadOpenPdf} disabled={busy === "download"}>
            <Download size={17} />
            {files.openUrl ? "下载开放 PDF" : busy === "download" ? "保存中" : "保存并下载开放 PDF"}
          </button>
        )}
        {files.openKey && (
          <button type="button" className="icon-button labeled danger-action" onClick={() => void deleteFile("open")} disabled={busy === "delete-open"}>
            <Trash2 size={16} />
            删除开放 PDF
          </button>
        )}
        <button type="button" className="secondary-action" onClick={exportCitation} disabled={busy === "citation"}>
          <FileText size={17} />
          {files.citationUrl ? "下载题录 PDF" : busy === "citation" ? "生成中" : "生成题录 PDF"}
        </button>
        {files.citationKey && (
          <button type="button" className="icon-button labeled danger-action" onClick={() => void deleteFile("citation")} disabled={busy === "delete-citation"}>
            <Trash2 size={16} />
            删除题录 PDF
          </button>
        )}
        {candidate.doi && (
          <button type="button" className="icon-button labeled" title="复制 DOI" onClick={() => copy(candidate.doi || "", "DOI")}>
            <Copy size={16} /> DOI
          </button>
        )}
        <button type="button" className="icon-button labeled" title="复制 BibTeX" onClick={() => copy(buildBib(candidate), "BibTeX")}>
          <Copy size={16} /> BibTeX
        </button>
      </div>
      <p className="compliance"><CheckCircle2 size={15} /> 无开放 PDF 时只导出题录 PDF，不显示“下载全文”。</p>
    </section>
  );
}

function ExportButton({ taskId, format, label, icon, json }: { taskId: string; format: string; label: string; icon: React.ReactNode; json?: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const disabled = !taskId || busy;
  const exportFile = async () => {
    if (!taskId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/batch/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${storage.token}`
        },
        body: JSON.stringify({ taskId, format })
      });
      if (!res.ok) throw new Error(await readError(res));
      if (json) {
        const data = await res.json();
        await downloadFile(data.downloadUrl, "citation-pdfs.zip");
      } else {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = format === "csv" ? "chem-paper-finder.csv" : "chem-paper-finder.bib";
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="secondary-action" onClick={exportFile} disabled={disabled} title={!taskId ? "先完成批量检索" : label}>
      {icon}
      {busy ? "导出中" : label}
    </button>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <Search size={24} />
      <p>{text}</p>
    </div>
  );
}

function statusText(status: string) {
  const map: Record<string, string> = {
    matched: "已匹配",
    multiple_candidates: "多候选",
    not_found: "未找到",
    failed: "失败"
  };
  return map[status] || status;
}

function formatDate(value?: string) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function avatarUrl(config: Config, user: User) {
  return user.avatar_url || `${config.authCenterUrl}/api/avatar/${user.uuid}`;
}

function Avatar({ config, user }: { config: Config; user: User }) {
  const label = user.name || user.username || "User";
  const initials = label.trim().slice(0, 2).toUpperCase();
  return (
    <span className="avatar-frame" aria-label={label}>
      <span className="avatar-fallback">{initials}</span>
      <img
        src={avatarUrl(config, user)}
        alt=""
        onError={(event) => {
          event.currentTarget.style.display = "none";
        }}
      />
    </span>
  );
}

function useCandidateFiles(candidate: Candidate | null) {
  const [files, setFiles] = React.useState<CandidateFiles>({
    openKey: candidate?.openPdfR2Key,
    openUrl: candidate?.openPdfDownloadUrl,
    citationKey: candidate?.citationPdfR2Key,
    citationUrl: candidate?.citationPdfDownloadUrl
  });

  React.useEffect(() => {
    setFiles({
      openKey: candidate?.openPdfR2Key,
      openUrl: candidate?.openPdfDownloadUrl,
      citationKey: candidate?.citationPdfR2Key,
      citationUrl: candidate?.citationPdfDownloadUrl
    });
  }, [candidate?.id, candidate?.openPdfR2Key, candidate?.openPdfDownloadUrl, candidate?.citationPdfR2Key, candidate?.citationPdfDownloadUrl]);

  return [files, setFiles] as const;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function api<T = unknown>(path: string, options: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.auth !== false && storage.token) headers.Authorization = `Bearer ${storage.token}`;
  const res = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    if (options.auth !== false && (res.status === 401 || res.status === 403)) {
      window.dispatchEvent(new Event("auth-expired"));
    }
    throw new Error(await readError(res));
  }
  return res.json() as Promise<T>;
}

async function uploadLandingBackground(file: File, opacity: number) {
  const form = new FormData();
  form.set("file", file);
  form.set("opacity", String(opacity));
  const headers: Record<string, string> = {};
  if (storage.token) headers.Authorization = `Bearer ${storage.token}`;
  const res = await fetch("/api/admin/landing-background", {
    method: "POST",
    headers,
    body: form
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) window.dispatchEvent(new Event("auth-expired"));
    throw new Error(await readError(res));
  }
  return res.json() as Promise<{ settings: SiteSettings }>;
}

async function downloadFile(path: string, fallbackFilename: string) {
  const headers: Record<string, string> = {};
  if (storage.token) headers.Authorization = `Bearer ${storage.token}`;
  const res = await fetch(path, { headers });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) window.dispatchEvent(new Event("auth-expired"));
    throw new Error(await readError(res));
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = readFilename(res.headers.get("Content-Disposition")) || fallbackFilename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFilename(disposition: string | null) {
  if (!disposition) return "";
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) return decodeURIComponent(utf8[1]);
  const ascii = disposition.match(/filename=\"?([^\";]+)\"?/i);
  return ascii?.[1] ?? "";
}

async function readError(res: Response) {
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    return data.message || data.error || text;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

function fileNameForCandidate(candidate: Candidate, kind: "open" | "citation") {
  const base = (candidate.doi || candidate.title || candidate.id)
    .replace(/^https?:\/\/doi\.org\//i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "paper";
  return `${base}-${kind}.pdf`;
}

function versionLabel(value?: string) {
  const labels: Record<string, string> = {
    publisher_version_of_record: "出版社正式开放版",
    author_accepted_manuscript: "作者接受稿",
    preprint: "预印本",
    repository_copy: "机构仓储版本",
    unknown_version: "版本未知"
  };
  return labels[value || ""] || "版本未知";
}

function granularityLabel(value?: string, derivedFrom?: string) {
  if (value === "volume_scan") return `整卷扫描${derivedFrom ? ` · ${derivedFrom}` : ""}`;
  if (value === "derived_from_volume_scan") return `由整卷扫描裁剪${derivedFrom ? ` · ${derivedFrom}` : ""}`;
  return derivedFrom || "单篇或未知";
}

function quotaSummary(quota: QuotaSnapshot | null) {
  if (!quota) return "正在同步";
  if (quota.ok === false) return quota.message || "额度未授权";
  const data = quota.data && typeof quota.data === "object" ? quota.data as Record<string, unknown> : {};
  const remaining = data.remaining_tokens ?? data.remainingTokens;
  const quotaValue = data.quota && typeof data.quota === "object" ? data.quota as Record<string, unknown> : {};
  const rpm = quotaValue.rpm ?? data.rpm;
  const rpd = quotaValue.rpd ?? data.rpd;
  const parts = [
    remaining !== undefined ? `剩余 ${remaining}` : "",
    rpm !== undefined ? `RPM ${rpm}` : "",
    rpd !== undefined ? `RPD ${rpd}` : ""
  ].filter(Boolean);
  return parts.join(" · ") || "已同步";
}

function isAdminUser(user: User) {
  return /^(admin|owner|super_admin|root)$/i.test(user.role || "");
}

function formatBytes(value?: number) {
  if (!value) return "未知大小";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function buildBib(paper: Candidate) {
  const key = `${paper.authors[0]?.split(/\s+/).at(-1) || "paper"}${paper.year || ""}`.replace(/[^a-z0-9]/gi, "");
  return [
    `@article{${key || "paper"},`,
    `  title = {${paper.title}},`,
    `  author = {${paper.authors.join(" and ")}},`,
    paper.journal ? `  journal = {${paper.journal}},` : "",
    paper.year ? `  year = {${paper.year}},` : "",
    paper.doi ? `  doi = {${paper.doi}},` : "",
    "}"
  ].filter(Boolean).join("\n");
}

async function track(eventType: string, uuid?: string) {
  if (!uuid) return;
  await fetch("/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uuid, event_type: eventType })
  }).catch(() => undefined);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
