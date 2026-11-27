const app = document.querySelector("#app");
const workbenchURL = document.querySelector('meta[name="hermes-workbench-url"]')?.content || "";
const savedMode = localStorage.getItem("hermes.connectionMode");
const initialMode = workbenchURL && savedMode !== "custom" ? "default" : "custom";
const savedURL = localStorage.getItem("hermes.serverURL") || "";
const savedKey = localStorage.getItem("hermes.apiKey") || "";
const state = {
  screen: "settings",
  connectionMode: initialMode,
  settingsMode: initialMode,
  serverURL: savedURL,
  apiKey: savedKey,
  serverDraft: savedURL,
  keyDraft: savedKey,
  sessions: [],
  session: null,
  messages: [],
  draft: "",
  titleDraft: "",
  status: "",
  error: "",
  sending: false,
  runId: null,
  liveReply: "",
  approvals: [],
  generation: 0
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function normalizeBase(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error("请输入完整的服务地址，例如 https://hermes.example.com/v1"); }
  if (url.username || url.password || url.search || url.hash) throw new Error("地址不能包含用户名、密码、查询参数或片段");
  const scheme = url.protocol.replace(":", "");
  const host = url.hostname.toLowerCase();
  if (!httpAllowed(scheme, host)) throw new Error("远程服务请使用 HTTPS；HTTP 仅用于局域网地址");
  let path = url.pathname.replace(/^\/+|\/+$/g, "");
  if (path === "v1") path = "";
  else if (path.endsWith("/v1")) path = path.slice(0, -3).replace(/\/+$/g, "");
  let port = url.port;
  if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) port = "";
  return `${scheme}://${host}${port ? ":" + port : ""}${path ? "/" + path : ""}`;
}

function httpAllowed(scheme, host) {
  if (scheme === "https") return true;
  if (scheme !== "http") return false;
  if (host === "localhost" || host.endsWith(".local")) return true;
  const bits = host.split(".");
  if (bits.length !== 4 || bits.some((part) => !/^\d+$/.test(part))) return false;
  const nums = bits.map(Number);
  if (nums.some((num) => num < 0 || num > 255)) return false;
  const [a, b] = nums;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function localProxy() {
  const host = location.hostname;
  return location.protocol === "http:" && (host === "127.0.0.1" || host === "localhost" || host.endsWith(".local"));
}

const HUB_ORIGIN = location.origin;

function connection(mode = state.connectionMode, serverURL = state.serverURL, apiKey = state.apiKey) {
  if (mode === "default") {
    return { base: workbenchURL, headers: { "X-Hermes-Workbench": "1" } };
  }
  const base = normalizeBase(serverURL);
  const headers = { "Authorization": "Bearer " + apiKey };
  if (!localProxy()) return { base, headers };
  headers["X-Hermes-Base"] = base;
  return { base: "/proxy", headers };
}

async function requestHermes(path, options, target = connection()) {
  try {
    return await fetch(target.base + path, {
      ...options,
      headers: { ...target.headers, ...options.headers }
    });
  } catch (error) {
    if (target.headers["X-Hermes-Workbench"]) {
      throw new Error("无法连接默认 Hermes。请确认 Tailscale 已连接，且 Hermes 地址走直连。");
    }
    throw error;
  }
}

async function api(path, options = {}, target) {
  const response = await requestHermes(path, options, target);
  const text = await response.text();
  if (!response.ok) throw new Error(`服务错误 ${response.status}：${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function visibleContent(value) {
  const text = Array.isArray(value)
    ? value.map((part) => part && part.type === "image_url" ? "[图片]" : redact(part && part.text || "")).join("\n")
    : redact(value || "");
  return text.trim();
}

function redact(value) {
  return String(value).replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "[图片]");
}

function visibleMessages(rows) {
  return (rows || []).filter((row) => row.display_kind !== "hidden" && visibleContent(row.content));
}

function render() {
  const focusId = document.activeElement && document.activeElement.id;
  const cursor = focusId && document.activeElement.selectionStart;
  app.innerHTML = template();
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (cursor != null && el.setSelectionRange) el.setSelectionRange(cursor, cursor);
    }
  }
  const hint = document.getElementById("hint");
  if (hint) {
    hint.textContent = state.settingsMode === "default"
      ? "使用已授权的 Tailscale 账号连接。"
      : localProxy()
      ? "本机打开。密钥只存在当前浏览器，经本地代理转发，可连接局域网 HTTP。"
      : "从统一入口打开。服务必须是 HTTPS，并允许来源 " + HUB_ORIGIN + "。局域网 HTTP 请用 python3 web/serve.py。";
  }
  const box = document.getElementById("messages");
  if (box) box.scrollTop = box.scrollHeight;
}

function template() {
  return `<header><h1>Hermes</h1><span class="spacer"></span>${nav()}</header>${body()}<p class="status" id="status">${esc(state.status)}</p><p class="error">${esc(state.error)}</p>`;
}

function hasConnection() {
  return state.connectionMode === "default" ? Boolean(workbenchURL) : Boolean(state.serverURL && state.apiKey);
}

function nav() {
  if (!hasConnection()) return "";
  if (state.screen === "chat") return `<button data-act="list">会话</button>`;
  if (state.screen === "sessions") return `<button data-act="settings">设置</button>`;
  return `<button data-act="list">返回</button>`;
}

function body() {
  if (state.screen === "settings" || !hasConnection()) return settingsView();
  if (state.screen === "chat" && state.session) return chatView();
  return sessionView();
}

function settingsView() {
  const modePicker = workbenchURL ? `<label><span>连接方式</span><select id="connectionMode">
    <option value="default" ${state.settingsMode === "default" ? "selected" : ""}>默认连接（Tailscale）</option>
    <option value="custom" ${state.settingsMode === "custom" ? "selected" : ""}>自定义连接</option>
  </select></label>` : "";
  const fields = state.settingsMode === "custom"
    ? `<label><span>服务地址</span><input id="serverURL" value="${esc(state.serverDraft)}" placeholder="https://hermes.example.com/v1"></label>
       <label><span>API 密钥</span><input id="apiKey" type="password" value="${esc(state.keyDraft)}"></label>`
    : "";
  return `<form class="card" data-act="save">
    ${modePicker}
    ${fields}
    <div class="row"><button type="button" data-act="test">测试连接</button><button class="primary" type="submit">保存</button></div>
    <p class="meta" id="hint"></p>
  </form>`;
}

function sessionView() {
  const rows = state.sessions.map((session) => `<button class="card session" data-act="open" data-id="${esc(session.id)}"><strong>${esc(session.title || "未命名会话")}</strong><small>${esc(session.preview || "")}</small></button>`).join("");
  return `<div class="row"><input id="titleDraft" placeholder="新会话标题" value="${esc(state.titleDraft)}"><button class="primary" data-act="create">新建</button><button data-act="refresh">刷新</button></div>
    <div class="list" style="margin-top:12px">${rows || `<p class="empty">还没有会话</p>`}</div>`;
}

function chatView() {
  const messages = visibleMessages(state.messages).map((message) => `<article class="card bubble ${message.role === "user" ? "user" : ""}"><div class="meta">${esc(message.role === "user" ? "我" : "Hermes")}</div>${esc(visibleContent(message.content))}</article>`).join("");
  const live = state.liveReply ? `<article class="card bubble" id="live">${esc(state.liveReply)}</article>` : `<article class="card bubble" id="live" hidden></article>`;
  const approvals = state.approvals.map((approval, index) => `<div class="card approval"><div class="meta">需要确认</div><p>${esc(approval.command || approval.description || "工具调用")}</p><div class="row">${(approval.choices || ["once", "deny"]).map((choice) => `<button data-act="approve" data-index="${index}" data-choice="${esc(choice)}">${esc(choiceLabel(choice))}</button>`).join("")}</div></div>`).join("");
  return `<h2>${esc(state.session.title || "未命名会话")}</h2>
    <div class="messages" id="messages">${messages}${live}${approvals}</div>
    <div class="row"><textarea id="draft" placeholder="输入消息">${esc(state.draft)}</textarea></div>
    <div class="row" style="margin-top:8px"><button class="primary" data-act="send" ${state.sending ? "disabled" : ""}>发送</button><button data-act="stop" ${state.sending ? "" : "disabled"}>停止</button><button data-act="delete">删除</button></div>`;
}

function choiceLabel(choice) {
  return { once: "允许一次", session: "本次会话允许", always: "始终允许", deny: "拒绝" }[choice] || choice;
}

app.addEventListener("click", (event) => {
  const node = event.target.closest("[data-act]");
  if (!node) return;
  const act = node.dataset.act;
  if (act === "settings") {
    state.screen = "settings";
    state.settingsMode = state.connectionMode;
    state.serverDraft = state.serverURL;
    state.keyDraft = state.apiKey;
    state.error = "";
    state.status = "";
    render();
  }
  if (act === "list") { state.screen = "sessions"; state.error = ""; render(); loadSessions(); }
  if (act === "refresh") loadSessions();
  if (act === "test") testConnection();
  if (act === "create") createSession();
  if (act === "open") openSession(node.dataset.id);
  if (act === "send") send();
  if (act === "stop") stopRun();
  if (act === "delete") deleteSession();
  if (act === "approve") resolveApproval(Number(node.dataset.index), node.dataset.choice);
});

app.addEventListener("submit", (event) => {
  event.preventDefault();
  saveSettings();
});

app.addEventListener("input", (event) => {
  if (event.target.id === "draft") state.draft = event.target.value;
  if (event.target.id === "titleDraft") state.titleDraft = event.target.value;
  if (event.target.id === "serverURL") state.serverDraft = event.target.value;
  if (event.target.id === "apiKey") state.keyDraft = event.target.value;
});

app.addEventListener("change", (event) => {
  if (event.target.id !== "connectionMode") return;
  state.settingsMode = event.target.value;
  state.error = "";
  state.status = "";
  render();
});

function settingsConnection() {
  if (state.settingsMode === "default") return connection("default");
  const url = document.getElementById("serverURL");
  const key = document.getElementById("apiKey");
  if (url) state.serverDraft = url.value;
  if (key) state.keyDraft = key.value;
  if (!state.keyDraft.trim()) throw new Error("请填写 API 密钥");
  return connection("custom", state.serverDraft, state.keyDraft);
}

function saveSettings() {
  try { settingsConnection(); }
  catch (error) { state.error = error.message; render(); return; }
  state.connectionMode = state.settingsMode;
  localStorage.setItem("hermes.connectionMode", state.connectionMode);
  if (state.connectionMode === "custom") {
    state.serverURL = state.serverDraft.trim();
    state.apiKey = state.keyDraft;
    localStorage.setItem("hermes.serverURL", state.serverURL);
    localStorage.setItem("hermes.apiKey", state.apiKey);
  }
  state.sessions = [];
  state.error = "";
  state.screen = "sessions";
  render();
  loadSessions();
}

async function testConnection() {
  state.error = "";
  try {
    const target = settingsConnection();
    state.status = "正在测试连接…";
    render();
    const body = await api("/v1/models", {}, target);
    const count = Array.isArray(body.data) ? body.data.length : 0;
    state.status = `已连接，${count} 个模型`;
  } catch (error) {
    state.error = error.message;
    state.status = "";
  }
  render();
}

async function loadSessions() {
  state.error = "";
  state.status = "正在读取会话…";
  render();
  try {
    const body = await api("/api/sessions?limit=50&offset=0&include_children=true");
    state.sessions = body.data || [];
    state.status = "";
  } catch (error) {
    state.error = error.message;
    state.status = "";
  }
  render();
}

async function createSession() {
  const title = (document.getElementById("titleDraft") || {}).value || state.titleDraft;
  state.titleDraft = title.trim();
  if (!state.titleDraft) { state.error = "请填写会话标题"; render(); return; }
  state.error = "";
  try {
    const body = await api("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: state.titleDraft }) });
    state.titleDraft = "";
    await loadSessions();
    if (body.session) openSession(body.session.id);
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function openSession(id) {
  const session = state.sessions.find((item) => item.id === id) || { id, title: "" };
  state.session = session;
  state.screen = "chat";
  state.messages = [];
  state.liveReply = "";
  state.approvals = [];
  state.error = "";
  state.status = "正在读取消息…";
  render();
  try {
    const body = await api(`/api/sessions/${encodeURIComponent(id)}/messages?order=latest&limit=100&offset=0&include_compacted=true&inline_images=false`);
    state.messages = body.data || [];
    if (body.session_id) state.session = Object.assign({}, state.session, { id: body.session_id });
    state.status = "";
  } catch (error) {
    state.error = error.message;
    state.status = "";
  }
  render();
}

async function deleteSession() {
  if (!state.session || !confirm("删除这个会话？")) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.session.id)}`, { method: "DELETE" });
    state.session = null;
    state.screen = "sessions";
    await loadSessions();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function send() {
  const draft = document.getElementById("draft");
  state.draft = draft ? draft.value : state.draft;
  const input = state.draft.trim();
  if (!input || state.sending || !state.session) return;
  const generation = ++state.generation;
  const sessionId = state.session.id;
  state.draft = "";
  state.sending = true;
  state.liveReply = "";
  state.approvals = [];
  state.runId = null;
  state.error = "";
  state.status = "Hermes 正在思考…";
  render();
  try {
    await stream(sessionId, input, generation);
    if (generation !== state.generation) return;
    state.status = "回复已完成";
    await refreshMessages(sessionId, generation);
  } catch (error) {
    if (generation !== state.generation) return;
    state.error = error.message;
    state.status = "";
  } finally {
    if (generation === state.generation) {
      state.sending = false;
      state.approvals = [];
      render();
    }
  }
}

async function refreshMessages(sessionId, generation) {
  const body = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?order=latest&limit=100&offset=0&include_compacted=true&inline_images=false`);
  if (generation !== state.generation) return;
  state.messages = body.data || [];
  state.liveReply = "";
  if (body.session_id && state.session) state.session = Object.assign({}, state.session, { id: body.session_id });
}

async function stream(sessionId, input, generation) {
  const response = await requestHermes(`/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream"
    },
    body: JSON.stringify({ input })
  });
  if (!response.ok) throw new Error(`服务错误 ${response.status}：${(await response.text()).slice(0, 300)}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawCompleted = false;
  let finalText = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let splitAt = buffer.indexOf("\n\n");
    while (splitAt >= 0) {
      const frame = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const parsed = parseFrame(frame);
      if (parsed) sawCompleted = handleEvent(parsed, generation, sessionId) || sawCompleted;
      if (state._final) finalText = state._final;
      splitAt = buffer.indexOf("\n\n");
    }
  }
  if (!sawCompleted) throw new Error("连接在回复完成前中断，请重试。");
  if (!finalText.trim() && !state.liveReply.trim()) throw new Error("Hermes 返回了空内容。");
}

function parseFrame(raw) {
  let event = null;
  const data = [];
  raw.replace(/\r/g, "").split("\n").forEach((line) => {
    if (!line || line.startsWith(":")) return;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  });
  if (!event) return null;
  try { return { event, data: data.length ? JSON.parse(data.join("\n")) : {} }; }
  catch { throw new Error("Hermes 返回的流式数据无效。"); }
}

function handleEvent(frame, generation, sessionId) {
  if (generation !== state.generation) return false;
  const payload = frame.data || {};
  if (payload.session_id && payload.session_id !== sessionId && state.session) {
    state.session = Object.assign({}, state.session, { id: payload.session_id });
  }
  if (frame.event === "run.started" && payload.run_id) {
    state.runId = payload.run_id;
    state.status = "正在回复";
  } else if (frame.event === "assistant.delta" && payload.delta) {
    state.liveReply += payload.delta;
    patchLive();
    return false;
  } else if (frame.event === "assistant.commentary" && payload.text) {
    state.status = payload.text;
  } else if (frame.event === "tool.started") {
    state.status = "正在运行：" + (payload.tool_name || "工具");
  } else if (frame.event === "tool.completed") {
    state.status = "工具已完成：" + (payload.tool_name || "工具");
  } else if (frame.event === "tool.failed") {
    state.status = "工具运行失败：" + (payload.tool_name || "工具");
  } else if (frame.event === "assistant.completed") {
    state._final = payload.content || state.liveReply;
    if (payload.content) state.liveReply = payload.content;
  } else if (frame.event === "approval.request") {
    state.approvals = state.approvals.concat([{
      runId: payload.run_id || state.runId,
      requestId: payload.request_id,
      command: payload.command,
      description: payload.description,
      choices: payload.choices && payload.choices.length ? payload.choices : ["once", "deny"]
    }]);
    render();
    return false;
  } else if (frame.event === "run.completed") {
    if (payload.completed === false || payload.partial === true || payload.interrupted === true) {
      throw new Error("服务端回复未完成：" + (payload.turn_exit_reason || "回复未完成"));
    }
    state._final = state._final || state.liveReply;
    return true;
  } else if (frame.event === "run.failed" || frame.event === "error") {
    throw new Error("服务端回复未完成：" + (payload.turn_exit_reason || payload.message || "服务端执行失败"));
  } else if (frame.event === "run.cancelled" || frame.event === "run.interrupted") {
    throw new Error("服务端已停止本次回复。");
  }
  const status = document.getElementById("status");
  if (status) status.textContent = state.status;
  return false;
}

function patchLive() {
  const live = document.getElementById("live");
  if (!live) { render(); return; }
  live.hidden = false;
  live.textContent = state.liveReply;
  const box = document.getElementById("messages");
  if (box) box.scrollTop = box.scrollHeight;
}

async function resolveApproval(index, choice) {
  const approval = state.approvals[index];
  if (!approval || !approval.runId) return;
  const body = { choice };
  if (approval.requestId) body.request_id = approval.requestId;
  try {
    await api(`/v1/runs/${encodeURIComponent(approval.runId)}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    state.approvals = state.approvals.filter((_, item) => item !== index);
    state.status = "已提交确认";
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function stopRun() {
  const runId = state.runId;
  state.generation += 1;
  state.sending = false;
  state.status = "正在停止…";
  render();
  if (!runId) return;
  try {
    await api(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
    state.status = "服务端已停止本次回复。";
  } catch (error) {
    state.error = error.message;
  }
  render();
}

if (hasConnection()) {
  state.screen = "sessions";
  render();
  loadSessions();
} else {
  render();
}
