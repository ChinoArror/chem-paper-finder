CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  user_id INTEGER,
  name TEXT,
  username TEXT,
  email TEXT,
  role TEXT,
  avatar_url TEXT,
  first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  doi TEXT UNIQUE,
  title TEXT,
  journal TEXT,
  year INTEGER,
  volume TEXT,
  issue TEXT,
  pages TEXT,
  authors_json TEXT,
  publisher TEXT,
  publisher_url TEXT,
  abstract TEXT,
  crossref_json TEXT,
  openalex_json TEXT,
  unpaywall_json TEXT,
  is_oa INTEGER DEFAULT 0,
  oa_status TEXT,
  license TEXT,
  pdf_url TEXT,
  r2_pdf_key TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS search_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  input_text TEXT NOT NULL,
  input_type TEXT,
  status TEXT DEFAULT 'pending',
  result_json TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS paper_pdf_candidates (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  source TEXT,
  pdf_url TEXT NOT NULL,
  landing_url TEXT,
  host_type TEXT,
  version TEXT,
  license TEXT,
  pdf_version_type TEXT,
  source_granularity TEXT,
  derived_from TEXT,
  is_publisher_version INTEGER DEFAULT 0,
  score REAL DEFAULT 0,
  verified INTEGER DEFAULT 0,
  verification_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS paper_files (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  candidate_id TEXT,
  user_id TEXT,
  r2_key TEXT NOT NULL,
  file_type TEXT,
  content_type TEXT,
  file_size INTEGER,
  content_hash TEXT,
  source_url TEXT,
  license TEXT,
  downloaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS paper_downloads (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  user_id TEXT,
  source_url TEXT,
  r2_key TEXT,
  license TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS citation_exports (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  user_id TEXT,
  format TEXT,
  r2_key TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_by TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
