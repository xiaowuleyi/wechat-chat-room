// 管理员账号密码只从环境变量读取（线上用 `wrangler secret put` 配置，
// 本地开发用 .dev.vars），仓库中不保留任何明文口令。

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export function adminCredentials(env) {
  return {
    username: env?.ADMIN_USERNAME ?? "",
    password: env?.ADMIN_PASSWORD ?? "",
  };
}

function adminSecret(env) {
  // 优先使用显式配置的 ADMIN_SECRET；未配置时由账号密码派生
  const { username, password } = adminCredentials(env);
  return env?.ADMIN_SECRET ?? `wxchat-token-secret::${username}::${password}`;
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueAdminToken(env) {
  const payload = b64urlEncode(JSON.stringify({ role: "admin", iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS }));
  const sig = await hmacSign(payload, adminSecret(env));
  return `${payload}.${sig}`;
}

export async function verifyAdminToken(token, env) {
  if (typeof token !== "string" || !token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSign(payload, adminSecret(env));
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return false;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    return data.role === "admin" && (!data.exp || Date.now() < data.exp);
  } catch {
    return false;
  }
}
