// Health Sync Server — Node.js + better-sqlite3
// 端到端加密：服务端只存密文
import { createServer } from "http";
import { createHash, randomBytes } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3000", 10);
const DB_PATH = process.env.DB_PATH || join(__dirname, "..", "data", "health.db");
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// 自动建表（首次启动）
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  auth_hash TEXT NOT NULL,
  auth_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  user_id INTEGER PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// 预编译语句
const stmts = {
  findUser: db.prepare("SELECT id, auth_hash, auth_salt FROM users WHERE email = ?"),
  insertUser: db.prepare("INSERT INTO users (email, auth_hash, auth_salt, created_at) VALUES (?, ?, ?, ?)"),
  insertSession: db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"),
  findSession: db.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  cleanExpired: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  getBlob: db.prepare("SELECT ciphertext, iv, version, updated_at FROM blobs WHERE user_id = ?"),
  upsertBlob: db.prepare(`INSERT INTO blobs (user_id, ciphertext, iv, version, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv,
      version=excluded.version, updated_at=excluded.updated_at`),
};

// 每小时清理过期 session
setInterval(() => {
  try { stmts.cleanExpired.run(Date.now()); } catch (e) {}
}, 3600 * 1000);

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}
function randHex(n = 16) {
  return randomBytes(n).toString("hex");
}
function validEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(data));
}
const bad = (res, msg, status = 400) => send(res, status, { error: msg });

function readJson(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function authUser(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const row = stmts.findSession.get(token);
  if (!row || row.expires_at < Date.now()) return null;
  return row.user_id;
}

const handlers = {
  "POST /api/register": async (req, res) => {
    const body = await readJson(req).catch(() => null);
    if (!body) return bad(res, "invalid json");
    const { email, auth_key } = body;
    if (!validEmail(email)) return bad(res, "invalid email");
    if (typeof auth_key !== "string" || auth_key.length < 32 || auth_key.length > 256)
      return bad(res, "invalid auth_key");

    const lower = email.toLowerCase();
    if (stmts.findUser.get(lower)) return bad(res, "email already registered", 409);

    const salt = randHex(16);
    const hash = sha256Hex(salt + ":" + auth_key);
    const now = Date.now();
    const result = stmts.insertUser.run(lower, hash, salt, now);
    const userId = result.lastInsertRowid;
    const token = randHex(32);
    stmts.insertSession.run(token, userId, now + TOKEN_TTL_MS);
    send(res, 200, { token, user_id: userId });
  },

  "POST /api/login": async (req, res) => {
    const body = await readJson(req).catch(() => null);
    if (!body) return bad(res, "invalid json");
    const { email, auth_key } = body;
    if (!validEmail(email) || typeof auth_key !== "string") return bad(res, "invalid input");

    const user = stmts.findUser.get(email.toLowerCase());
    if (!user) return bad(res, "invalid credentials", 401);

    const hash = sha256Hex(user.auth_salt + ":" + auth_key);
    if (hash !== user.auth_hash) return bad(res, "invalid credentials", 401);

    const token = randHex(32);
    stmts.insertSession.run(token, user.id, Date.now() + TOKEN_TTL_MS);
    send(res, 200, { token, user_id: user.id });
  },

  "POST /api/logout": async (req, res) => {
    const auth = req.headers["authorization"] || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (token) stmts.deleteSession.run(token);
    send(res, 200, { ok: true });
  },

  "GET /api/sync": async (req, res) => {
    const userId = authUser(req);
    if (!userId) return bad(res, "unauthorized", 401);
    const row = stmts.getBlob.get(userId);
    if (!row) return send(res, 200, { blob: null, version: 0 });
    send(res, 200, {
      blob: { ciphertext: row.ciphertext, iv: row.iv },
      version: row.version,
      updated_at: row.updated_at,
    });
  },

  "PUT /api/sync": async (req, res) => {
    const userId = authUser(req);
    if (!userId) return bad(res, "unauthorized", 401);
    const body = await readJson(req).catch(() => null);
    if (!body) return bad(res, "invalid json");
    const { ciphertext, iv, base_version } = body;
    if (typeof ciphertext !== "string" || typeof iv !== "string") return bad(res, "invalid blob");
    if (ciphertext.length > MAX_BLOB_BYTES) return bad(res, "blob too large", 413);

    const cur = stmts.getBlob.get(userId);
    const curVer = cur ? cur.version : 0;
    if (typeof base_version === "number" && base_version !== curVer) {
      return send(res, 409, { error: "version conflict", current_version: curVer });
    }
    const newVer = curVer + 1;
    const now = Date.now();
    stmts.upsertBlob.run(userId, ciphertext, iv, newVer, now);
    send(res, 200, { version: newVer, updated_at: now });
  },

  "GET /api/health": async (_req, res) => send(res, 200, { ok: true, ts: Date.now() }),
};

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  const handler = handlers[key];
  if (!handler) return bad(res, "not found", 404);
  try {
    await handler(req, res);
  } catch (e) {
    console.error(`[${key}]`, e);
    bad(res, "server error: " + e.message, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`✓ Health Sync server listening on http://127.0.0.1:${PORT}`);
  console.log(`  DB: ${DB_PATH}`);
});

process.on("SIGTERM", () => { server.close(); db.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); db.close(); process.exit(0); });
