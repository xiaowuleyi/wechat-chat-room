import { ChatRoom } from "./room.js";
import { adminCredentials, issueAdminToken } from "./auth.js";

export { ChatRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/login") {
      return handleLogin(request, env);
    }

    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ ok: false, error: "Expected WebSocket" }, 426);
      }
      const id = env.CHAT_ROOM.idFromName("global");
      return env.CHAT_ROOM.get(id).fetch(request);
    }

    return json({ ok: false, error: "Not Found" }, 404);
  },
};

async function handleLogin(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Bad Request" }, 400);
  }

  const { username, password } = adminCredentials(env);
  if (
    typeof body?.username !== "string" ||
    typeof body?.password !== "string" ||
    body.username !== username ||
    body.password !== password
  ) {
    // 稍作延迟，弱化爆破尝试
    await new Promise((r) => setTimeout(r, 300));
    return json({ ok: false, error: "账号或密码错误" }, 401);
  }

  const token = await issueAdminToken(env);
  return json({ ok: true, token });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
