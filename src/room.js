import { DurableObject } from "cloudflare:workers";
import { verifyAdminToken } from "./auth.js";

// 全局唯一聊天室：所有在线状态只放在内存里，绝不写入任何存储。
// 采用"常驻内存"的 WebSocket（不用 Hibernation）：只要房间还有人，历史一致可见；
// 所有人离开后实例被回收，消息自然全部蒸发 —— 这正是"不保存聊天记录"的语义。
const MAX_HISTORY = 50;        // 仅在内存里保留最近 50 条，供新加入者同步
const MAX_TEXT_LEN = 2000;     // 单条消息硬上限
const MIN_SEND_INTERVAL = 200; // 简易防刷：同一连接两条消息最小间隔

const ADJECTIVES = [
  "温柔的", "快乐的", "爱笑的", "安静的", "勇敢的", "机智的",
  "元气满满的", "闪闪的", "认真的", "自由的", "贪睡的", "好奇的",
];
const ANIMALS = [
  "柯基", "橘猫", "柴犬", "小鹿", "水獭", "刺猬", "熊猫",
  "海豚", "企鹅", "考拉", "狐狸", "兔子", "仓鼠", "猫头鹰",
];

function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const num = 100 + Math.floor(Math.random() * 900);
  return `${a}${n}${num}`;
}

// 普通用户昵称：允许刷新后沿用（客户端 sessionStorage 携带），但保留"管理员"称呼
function pickGuestName(raw) {
  const candidate = (raw || "").trim();
  const ok = candidate.length >= 1 && candidate.length <= 20 && !candidate.includes("管理员") && /^[\p{Script=Han}A-Za-z0-9_·-]+$/u.test(candidate);
  return ok ? candidate : randomName();
}

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sockets = new Map(); // WebSocket -> { name, isAdmin, lastTs }
    this.messages = [];       // 内存态：最近消息
    this.pinned = null;       // 内存态：置顶消息
    this.closed = false;      // 内存态：群聊是否已关闭
    this.nextId = 1;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ws" && request.headers.get("Upgrade") === "websocket") {
      return this.handleConnect(url);
    }
    return new Response("Not Found", { status: 404 });
  }

  async handleConnect(url) {
    const isAdmin = await verifyAdminToken(url.searchParams.get("token") || "", this.env);
    const name = isAdmin ? "管理员" : pickGuestName(url.searchParams.get("name"));

    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.sockets.set(server, { name, isAdmin, lastTs: 0 });

    server.addEventListener("message", (e) => {
      const raw = typeof e.data === "string" ? e.data : "";
      this.handleMessage(server, raw);
    });
    server.addEventListener("close", () => this.afterLeave(server));
    server.addEventListener("error", () => {
      try { server.close(); } catch {}
      this.afterLeave(server);
    });

    const online = this.sockets.size;
    // 先给新连接发全量快照
    server.send(JSON.stringify({
      type: "init",
      you: { name, isAdmin },
      messages: this.messages,
      pinned: this.pinned,
      closed: this.closed,
      online,
    }));
    // 再广播在线人数；加入提示只发给其他人
    this.broadcast({ type: "online", count: online });
    this.broadcast({ type: "system", text: `${name} 加入了群聊` }, server);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  handleMessage(ws, raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data.type !== "string") return;

    const meta = this.sockets.get(ws);
    if (!meta) return;
    const now = Date.now();

    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", ts: now }));
      return;
    }

    if (data.type === "chat") {
      if (now - meta.lastTs < MIN_SEND_INTERVAL) return;
      meta.lastTs = now;

      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text || text.length > MAX_TEXT_LEN) return;
      if (this.closed && !meta.isAdmin) {
        ws.send(JSON.stringify({ type: "error", text: "群聊已关闭，暂时无法发言" }));
        return;
      }

      const msg = {
        id: this.nextId++,
        name: meta.isAdmin ? "管理员" : meta.name,
        isAdmin: !!meta.isAdmin,
        text,
        ts: now,
      };
      this.messages.push(msg);
      while (this.messages.length > MAX_HISTORY) this.messages.shift();
      // 置顶消息若已滑出历史窗口，自动取消置顶
      if (this.pinned && !this.messages.some((m) => m.id === this.pinned.id)) {
        this.pinned = null;
        this.broadcast({ type: "state", pinned: null, closed: this.closed });
      }
      this.broadcast({ type: "chat", msg });
      return;
    }

    if (data.type === "pin") {
      if (!meta.isAdmin) return;
      const msg = this.messages.find((m) => m.id === Number(data.id));
      if (!msg) {
        ws.send(JSON.stringify({ type: "error", text: "该消息已不在保留范围内，无法置顶" }));
        return;
      }
      this.pinned = msg;
      this.broadcast({ type: "state", pinned: this.pinned, closed: this.closed });
      return;
    }

    if (data.type === "unpin") {
      if (!meta.isAdmin) return;
      this.pinned = null;
      this.broadcast({ type: "state", pinned: null, closed: this.closed });
      return;
    }

    if (data.type === "setClosed") {
      if (!meta.isAdmin) return;
      this.closed = !!data.closed;
      this.broadcast({ type: "state", pinned: this.pinned, closed: this.closed });
      this.broadcast({
        type: "system",
        text: this.closed ? "管理员已关闭群聊，仅管理员可以发言" : "管理员已开启群聊，欢迎大家继续发言",
      });
    }
  }

  afterLeave(ws) {
    if (!this.sockets.has(ws)) return;
    const { name } = this.sockets.get(ws);
    this.sockets.delete(ws);
    this.broadcast({ type: "online", count: this.sockets.size });
    if (name) this.broadcast({ type: "system", text: `${name} 退出了群聊` });
  }

  broadcast(obj, exclude) {
    const raw = JSON.stringify(obj);
    for (const ws of this.sockets.keys()) {
      if (ws === exclude) continue;
      try { ws.send(raw); } catch {}
    }
  }
}
