(() => {
  "use strict";

  const FOLD_LEN = 100; // 超过 100 字折叠

  const $ = (s) => document.querySelector(s);
  const messagesEl = $("#messages");
  const inputEl = $("#input");
  const sendBtn = $("#sendBtn");
  const emptyStateEl = $("#emptyState");
  const newMsgPill = $("#newMsgPill");
  const statusDot = $("#statusDot");
  const statusText = $("#statusText");
  const onlineCountEl = $("#onlineCount");
  const pinnedBar = $("#pinnedBar");
  const pinText = $("#pinText");
  const unpinX = $("#unpinX");
  const adminBtn = $("#adminBtn");
  const adminBar = $("#adminBar");
  const closeSwitch = $("#closeSwitch");
  const unpinBtn = $("#unpinBtn");
  const closedBanner = $("#closedBanner");
  const adminModal = $("#adminModal");
  const adminForm = $("#adminForm");
  const adminUser = $("#adminUser");
  const adminPass = $("#adminPass");
  const adminErr = $("#adminErr");
  const adminSubmit = $("#adminSubmit");
  const modalCard = adminModal.querySelector(".modal-card");
  const copyAllBtn = $("#copyAllBtn");

  const AVATARS = [
    ["#74c0fc", "#3b8fd4"], ["#ffd8a8", "#f59f00"], ["#b2f2bb", "#37b24d"],
    ["#ffc9c9", "#f03e3e"], ["#d0bfff", "#7048e8"], ["#99e9f2", "#0c8599"],
    ["#fcc2d7", "#d6336c"], ["#ffe066", "#f08c00"], ["#c3fae8", "#0ca678"],
  ];

  const state = {
    ws: null,
    connected: false,
    you: { name: "", isAdmin: false },
    msgById: new Map(),
    pinned: null,
    closed: false,
    online: 0,
    retryTimer: null,
    retryDelay: 1000,
    intentionalClose: false,
    lastDay: "",
    nearBottom: true,
    token: sessionStorage.getItem("wx.token") || "",
    name: sessionStorage.getItem("wx.name") || "",
  };

  /* ---------- 工具 ---------- */

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function hash(str) {
    let h = 0;
    for (const c of str) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return h;
  }

  function avatarBg(name) {
    const [a, b] = AVATARS[hash(name || "?") % AVATARS.length];
    return `background:linear-gradient(135deg, ${a}, ${b})`;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function fmtDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(Date.now() - 86400000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, today)) return "今天";
    if (same(d, yest)) return "昨天";
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0;top:0;left:0;";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  let toastTimer = 0;
  function toast(text, type) {
    const box = $("#toasts");
    box.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = el("div", "toast" + (type ? " " + type : ""), text);
    box.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 320);
    }, 2200);
  }

  /* ---------- 状态渲染 ---------- */

  function setStatus(mode) {
    statusDot.classList.remove("online", "offline");
    if (mode === "online") { statusDot.classList.add("online"); statusText.textContent = "在线"; }
    else if (mode === "offline") { statusDot.classList.add("offline"); statusText.textContent = "连接断开，重连中…"; }
    else statusText.textContent = "连接中…";
  }

  function isAdmin() { return state.you.isAdmin; }

  function renderState() {
    // 置顶条
    if (state.pinned) {
      pinnedBar.classList.remove("hidden");
      pinText.textContent = `${state.pinned.name}：${state.pinned.text.length > 60 ? state.pinned.text.slice(0, 60) + "…" : state.pinned.text}`;
      unpinX.classList.toggle("hidden", !isAdmin());
      unpinBtn.classList.toggle("hidden", !isAdmin());
    } else {
      pinnedBar.classList.add("hidden");
      unpinBtn.classList.add("hidden");
    }

    // 关闭状态
    closedBanner.classList.toggle("hidden", !(state.closed && !isAdmin()));
    const locked = state.closed && !isAdmin();
    inputEl.disabled = locked;
    sendBtn.disabled = locked;
    inputEl.placeholder = locked ? "群聊已关闭，仅管理员可以发言" : "输入消息，Enter 发送，Shift + Enter 换行";

    // 管理员条
    adminBar.classList.toggle("hidden", !isAdmin());
    closeSwitch.checked = state.closed;
    adminBtn.textContent = isAdmin() ? "退出管理员" : "管理员登录";
    adminBtn.classList.toggle("admin-entry", !isAdmin());
  }

  function updateEmpty() {
    const hasChat = [...state.msgById.keys()].length > 0;
    emptyStateEl.classList.toggle("hidden", hasChat);
  }

  /* ---------- 消息渲染 ---------- */

  function scrollBottom(smooth) {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    state.nearBottom = true;
    newMsgPill.classList.add("hidden");
  }

  messagesEl.addEventListener("scroll", () => {
    state.nearBottom = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 90;
    if (state.nearBottom) newMsgPill.classList.add("hidden");
  });
  newMsgPill.addEventListener("click", () => scrollBottom(true));

  function appendDayDivider(ts) {
    const day = fmtDay(ts);
    if (day === state.lastDay) return;
    state.lastDay = day;
    const line = el("div", "day-divider");
    line.appendChild(el("span", null, `${day} ${new Date(ts).getFullYear()}/${new Date(ts).getMonth() + 1}/${new Date(ts).getDate()}`));
    messagesEl.appendChild(line);
  }

  function appendSystem(text) {
    const line = el("div", "sys-line");
    line.appendChild(el("span", null, text));
    messagesEl.appendChild(line);
  }

  function buildBubble(m) {
    const isSelf = m.name === state.you.name && !m.isAdmin;
    const wrap = el("div", "msg" + (isSelf ? " self" : ""));
    wrap.dataset.id = m.id;

    const avatar = el("div", "avatar" + (m.isAdmin ? " admin" : ""), m.isAdmin ? "管" : (m.name || "?").slice(0, 1));
    avatar.setAttribute("style", avatarBg(m.name));

    const body = el("div", "msg-body");
    const meta = el("div", "meta");
    const nick = el("span", "nick" + (m.isAdmin ? " admin-name" : ""), m.isAdmin ? "管理员" : m.name);
    meta.appendChild(nick);
    if (m.isAdmin) meta.appendChild(el("span", "badge", "群主"));
    meta.appendChild(el("span", "time", fmtTime(m.ts)));
    body.appendChild(meta);

    const bubble = el("div", "bubble");
    const textWrap = el("div", "text-wrap");
    const long = m.text.length > FOLD_LEN;
    const shortEl = el("div", "text");
    shortEl.textContent = long ? m.text.slice(0, FOLD_LEN) + "…" : m.text;
    textWrap.appendChild(shortEl);
    if (long) {
      const fullEl = el("div", "text full hidden");
      fullEl.textContent = m.text;
      textWrap.appendChild(fullEl);
      const tgl = el("button", "fold-toggle", "展开全文");
      tgl.type = "button";
      tgl.addEventListener("click", (e) => {
        e.stopPropagation();
        const expand = fullEl.classList.contains("hidden");
        fullEl.classList.toggle("hidden", !expand);
        shortEl.classList.toggle("hidden", expand);
        tgl.textContent = expand ? "收起" : "展开全文";
      });
      textWrap.appendChild(tgl);
    }
    bubble.appendChild(textWrap);
    body.appendChild(bubble);
    wrap.appendChild(avatar);
    wrap.appendChild(body);

    // 悬浮操作
    const actions = el("div", "msg-actions");
    const copyBtn = el("button", null, "复制");
    copyBtn.type = "button";
    copyBtn.dataset.act = "copy";
    actions.appendChild(copyBtn);
    if (isAdmin()) {
      const pinBtn = el("button", "act-pin", "置顶");
      pinBtn.type = "button";
      pinBtn.dataset.act = "pin";
      actions.appendChild(pinBtn);
    }
    wrap.appendChild(actions);

    return wrap;
  }

  function appendMessage(m, opts = {}) {
    appendDayDivider(m.ts);
    const node = buildBubble(m);
    messagesEl.appendChild(node);
    state.msgById.set(m.id, m);
    updateEmpty();
    if (!opts.silent) {
      if (state.nearBottom) scrollBottom(true);
      else newMsgPill.classList.remove("hidden");
    }
  }

  function renderInit(messages) {
    messagesEl.querySelectorAll(".msg, .day-divider, .sys-line").forEach((n) => n.remove());
    state.msgById.clear();
    state.lastDay = "";
    for (const m of messages) {
      appendDayDivider(m.ts);
      messagesEl.appendChild(buildBubble(m));
      state.msgById.set(m.id, m);
    }
    updateEmpty();
    scrollBottom(false);
  }

  /* ---------- 事件委托：复制 / 置顶 ---------- */

  messagesEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const node = btn.closest(".msg[data-id]");
    const m = node && state.msgById.get(Number(node.dataset.id));
    if (!m) return;
    if (btn.dataset.act === "copy") {
      const ok = await copyText(m.text);
      toast(ok ? "已复制该条消息" : "复制失败", ok ? undefined : "warn");
    } else if (btn.dataset.act === "pin") {
      send({ type: "pin", id: m.id });
    }
  });

  pinnedBar.addEventListener("click", (e) => {
    if (e.target === unpinX) return;
    if (!state.pinned) return;
    const node = messagesEl.querySelector(`.msg[data-id="${state.pinned.id}"]`);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("flash");
      setTimeout(() => node.classList.remove("flash"), 1400);
    } else {
      toast("该消息已超出保留范围", "warn");
    }
  });
  unpinX.addEventListener("click", () => send({ type: "unpin" }));
  unpinBtn.addEventListener("click", () => send({ type: "unpin" }));

  /* ---------- 复制全部 ---------- */

  copyAllBtn.addEventListener("click", async () => {
    const list = [...state.msgById.values()].sort((a, b) => a.id - b.id);
    if (!list.length) { toast("还没有聊天记录", "warn"); return; }
    const lines = list.map((m) => `${m.isAdmin ? "管理员" : m.name}：${m.text}`);
    const header = `【群聊记录】共 ${list.length} 条 · 导出于 ${new Date().toLocaleString("zh-CN")}`;
    const ok = await copyText(`${header}\n${lines.join("\n")}`);
    toast(ok ? `已复制 ${list.length} 条聊天记录` : "复制失败", ok ? undefined : "warn");
  });

  /* ---------- WebSocket ---------- */

  function send(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
      return true;
    }
    toast("未连接，请稍候", "warn");
    return false;
  }

  function connect() {
    clearTimeout(state.retryTimer);
    state.intentionalClose = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const qs = new URLSearchParams({ name: state.name, token: state.token });
    setStatus("connecting");
    const ws = new WebSocket(`${proto}://${location.host}/api/ws?${qs.toString()}`);
    state.ws = ws;

    ws.onmessage = (e) => {
      let d;
      try { d = JSON.parse(e.data); } catch { return; }
      handleServer(d);
    };
    ws.onclose = () => {
      state.connected = false;
      if (state.intentionalClose) return;
      setStatus("offline");
      state.retryDelay = Math.min(state.retryDelay * 1.6, 8000);
      state.retryTimer = setTimeout(connect, state.retryDelay);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function reconnect() {
    if (state.ws) { state.intentionalClose = true; try { state.ws.close(); } catch {} }
    state.retryDelay = 1000;
    connect();
  }

  function handleServer(d) {
    switch (d.type) {
      case "init": {
        state.you = d.you;
        state.connected = true;
        state.retryDelay = 1000;
        state.pinned = d.pinned;
        state.closed = d.closed;
        state.online = d.online;
        onlineCountEl.textContent = d.online;
        setStatus("online");
        renderInit(d.messages || []);
        renderState();
        appendSystem(d.you.isAdmin ? `管理员模式已开启，当前昵称：管理员` : `已连接，你的昵称是【${d.you.name}】`);
        scrollBottom(false);
        break;
      }
      case "chat": {
        appendMessage(d.msg);
        break;
      }
      case "system": {
        appendSystem(d.text);
        if (state.nearBottom) scrollBottom(true);
        break;
      }
      case "state": {
        const wasClosed = state.closed;
        state.pinned = d.pinned;
        state.closed = d.closed;
        renderState();
        if (!wasClosed && d.closed && !isAdmin()) toast("管理员关闭了群聊", "warn");
        if (wasClosed && !d.closed) toast("群聊已开启");
        break;
      }
      case "online": {
        state.online = d.count;
        onlineCountEl.textContent = d.count;
        break;
      }
      case "error": {
        toast(d.text || "操作失败", "warn");
        break;
      }
      case "pong": break;
    }
  }

  /* ---------- 发送 ---------- */

  function submit() {
    const text = inputEl.value.trim();
    if (!text) return;
    if (text.length > 2000) { toast("消息太长啦（最多 2000 字）", "warn"); return; }
    if (state.closed && !isAdmin()) { toast("群聊已关闭，暂时无法发言", "warn"); return; }
    if (send({ type: "chat", text })) {
      inputEl.value = "";
      autosize();
      inputEl.focus();
    }
  }

  sendBtn.addEventListener("click", submit);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 132) + "px";
  }
  inputEl.addEventListener("input", autosize);

  /* ---------- 管理员 ---------- */

  adminBtn.addEventListener("click", () => {
    if (isAdmin()) {
      state.token = "";
      sessionStorage.removeItem("wx.token");
      toast("已退出管理员");
      reconnect();
    } else {
      openModal();
    }
  });

  closeSwitch.addEventListener("change", () => {
    send({ type: "setClosed", closed: closeSwitch.checked });
  });

  function openModal() {
    adminErr.classList.add("hidden");
    adminModal.classList.remove("hidden");
    setTimeout(() => adminUser.focus(), 60);
  }
  function closeModal() {
    adminModal.classList.add("hidden");
    adminForm.reset();
    adminErr.classList.add("hidden");
  }
  $("#adminCancel").addEventListener("click", closeModal);
  $("#modalClose").addEventListener("click", closeModal);
  adminModal.addEventListener("click", (e) => { if (e.target === adminModal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !adminModal.classList.contains("hidden")) closeModal(); });

  adminForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    adminSubmit.disabled = true;
    adminSubmit.textContent = "登录中…";
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: adminUser.value.trim(), password: adminPass.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "登录失败");
      state.token = data.token;
      sessionStorage.setItem("wx.token", state.token);
      closeModal();
      toast("管理员登录成功");
      reconnect();
    } catch (err) {
      adminErr.textContent = err.message;
      adminErr.classList.remove("hidden");
      modalCard.classList.remove("shake");
      void modalCard.offsetWidth;
      modalCard.classList.add("shake");
    } finally {
      adminSubmit.disabled = false;
      adminSubmit.textContent = "登 录";
    }
  });

  /* ---------- 启动 ---------- */

  connect();
})();
