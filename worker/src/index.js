// Health Sync — Cloudflare Worker
// 端到端加密：服务端只存密文，永远不知道明文内容
// 用户密码 → 浏览器侧 PBKDF2 派生 auth_key (上送) + enc_key (本地保留)

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const MAX_BLOB_BYTES = 2 * 1024 * 1024; // 2MB 上限

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    },
  });
}

function bad(msg, status = 400) {
  return json({ error: msg }, status);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

function validEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
}

async function authUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT user_id, expires_at FROM sessions WHERE token = ?"
  ).bind(token).first();
  if (!row || row.expires_at < Date.now()) return null;
  return row.user_id;
}

async function handleRegister(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("invalid json");
  const { email, auth_key } = body;
  if (!validEmail(email)) return bad("invalid email");
  if (typeof auth_key !== "string" || auth_key.length < 32 || auth_key.length > 256) {
    return bad("invalid auth_key");
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email.toLowerCase()).first();
  if (existing) return bad("email already registered", 409);

  const salt = randHex(16);
  const hash = await sha256Hex(salt + ":" + auth_key);
  const now = Date.now();

  const result = await env.DB.prepare(
    "INSERT INTO users (email, auth_hash, auth_salt, created_at) VALUES (?, ?, ?, ?)"
  ).bind(email.toLowerCase(), hash, salt, now).run();

  const userId = result.meta.last_row_id;
  const token = randHex(32);
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
  ).bind(token, userId, now + TOKEN_TTL_MS).run();

  return json({ token, user_id: userId });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("invalid json");
  const { email, auth_key } = body;
  if (!validEmail(email) || typeof auth_key !== "string") return bad("invalid input");

  const user = await env.DB.prepare(
    "SELECT id, auth_hash, auth_salt FROM users WHERE email = ?"
  ).bind(email.toLowerCase()).first();
  if (!user) return bad("invalid credentials", 401);

  const hash = await sha256Hex(user.auth_salt + ":" + auth_key);
  if (hash !== user.auth_hash) return bad("invalid credentials", 401);

  const token = randHex(32);
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
  ).bind(token, user.id, Date.now() + TOKEN_TTL_MS).run();

  return json({ token, user_id: user.id });
}

async function handleLogout(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  }
  return json({ ok: true });
}

async function handleGetBlob(request, env) {
  const userId = await authUser(request, env);
  if (!userId) return bad("unauthorized", 401);

  const row = await env.DB.prepare(
    "SELECT ciphertext, iv, version, updated_at FROM blobs WHERE user_id = ?"
  ).bind(userId).first();
  if (!row) return json({ blob: null, version: 0 });
  return json({
    blob: { ciphertext: row.ciphertext, iv: row.iv },
    version: row.version,
    updated_at: row.updated_at,
  });
}

async function handlePutBlob(request, env) {
  const userId = await authUser(request, env);
  if (!userId) return bad("unauthorized", 401);

  const body = await request.json().catch(() => null);
  if (!body) return bad("invalid json");
  const { ciphertext, iv, base_version } = body;
  if (typeof ciphertext !== "string" || typeof iv !== "string") return bad("invalid blob");
  if (ciphertext.length > MAX_BLOB_BYTES) return bad("blob too large", 413);

  const cur = await env.DB.prepare("SELECT version FROM blobs WHERE user_id = ?")
    .bind(userId).first();
  const curVer = cur ? cur.version : 0;

  if (typeof base_version === "number" && base_version !== curVer) {
    return json({ error: "version conflict", current_version: curVer }, 409);
  }

  const newVer = curVer + 1;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO blobs (user_id, ciphertext, iv, version, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       ciphertext=excluded.ciphertext, iv=excluded.iv,
       version=excluded.version, updated_at=excluded.updated_at`
  ).bind(userId, ciphertext, iv, newVer, now).run();

  return json({ version: newVer, updated_at: now });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p === "/api/register" && request.method === "POST") return handleRegister(request, env);
      if (p === "/api/login" && request.method === "POST") return handleLogin(request, env);
      if (p === "/api/logout" && request.method === "POST") return handleLogout(request, env);
      if (p === "/api/sync" && request.method === "GET") return handleGetBlob(request, env);
      if (p === "/api/sync" && request.method === "PUT") return handlePutBlob(request, env);
      if (p === "/api/health") return json({ ok: true, ts: Date.now() });
      return bad("not found", 404);
    } catch (e) {
      return bad("server error: " + e.message, 500);
    }
  },
};
