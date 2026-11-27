/*
 * Hermes Web 5.0: the server side of the iOS app in a browser. Workbench inbox, server sessions,
 * approvals and run state, scheduled jobs, pairing and appearance. Device-local content of the
 * iOS app (local conversations, projects, knowledge, message library, drafts, backups) is not here.
 */
(function () {
  "use strict";

  const Core = window.HermesCore;
  const { esc } = Core;
  const app = document.getElementById("app");
  const overlay = document.getElementById("overlay");
  const workbenchURL = document.querySelector('meta[name="hermes-workbench-url"]')?.content || "";
  const HUB_ORIGIN = location.origin;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  // Same storage as earlier web releases: the custom connection's key stays in this browser's
  // localStorage. Only one key is kept; the default connection never has a key in the browser.
  const KEYS = {
    mode: "hermes.connectionMode",
    url: "hermes.serverURL",
    key: "hermes.apiKey",
    name: "hermes.connectionName",
    appearance: "hermes.appearance",
    refresh: "hermes.jobsRefreshSeconds",
    relayOpen: "hermes.relayAllRoutes"
  };
  const OUTCOMES_KEY = "hermes.inboxResults"; // sessionStorage: run results seen in this tab

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } }
  };

  // ------------------------------------------------------------------ state

  const savedMode = store.get(KEYS.mode);
  const state = {
    route: { name: "home" },
    conn: {
      mode: workbenchURL && savedMode !== "custom" ? "default" : "custom",
      url: store.get(KEYS.url) || "",
      key: store.get(KEYS.key) || "",
      name: store.get(KEYS.name) || ""
    },
    connStatus: "unconfigured",
    models: [],
    generation: 0,
    appearance: ["light", "dark"].includes(store.get(KEYS.appearance)) ? store.get(KEYS.appearance) : "system",
    remote: newRemoteState(),
    jobs: newJobsState(),
    conversations: new Map(),
    currentKey: null,
    drafts: new Map(),
    outcomes: [],
    form: null,
    modal: null,
    menu: null,
    toast: null
  };

  function newRemoteState() {
    return { sessions: [], loaded: false, hasMore: false, nextOffset: 0, loading: false, loadingMore: false, error: null,
      updatedAt: null, generation: 0, busyId: null, query: "", pinnedOnly: false };
  }

  function newJobsState(previous) {
    const seconds = Number(store.get(KEYS.refresh));
    return { list: [], loaded: false, loading: false, error: null, updatedAt: null, generation: 0, busyId: null,
      refreshingId: null, detailError: null, notice: "", filter: previous ? previous.filter : "all",
      query: previous ? previous.query : "", refreshSeconds: Core.REFRESH_INTERVALS.includes(seconds) ? seconds : 0 };
  }

  // ------------------------------------------------------------------ connection

  function localProxy() {
    const host = location.hostname;
    return location.protocol === "http:" && (host === "127.0.0.1" || host === "localhost" || host.endsWith(".local"));
  }

  function hasConnection(conn = state.conn) {
    return conn.mode === "default" ? Boolean(workbenchURL) : Boolean(conn.url && conn.key);
  }

  function connectionValid() {
    if (!hasConnection()) return false;
    if (state.conn.mode === "default") return true;
    try { Core.normalizeBase(state.conn.url); return true; } catch { return false; }
  }

  function networkHint(base) {
    if (localProxy()) return "请确认 python3 web/serve.py 仍在运行。";
    if (location.protocol === "https:" && base.startsWith("http:") && !Core.isLoopbackAddress(base)) {
      return "当前页面通过 HTTPS 打开，浏览器会拦截 HTTP 服务。请改用 HTTPS 地址，或在本机运行 python3 web/serve.py。";
    }
    return `请检查地址和网络，并确认服务允许来源 ${HUB_ORIGIN}（CORS）。`;
  }

  // Until a request outside the relay's known routes has worked once, the default connection
  // does not send such requests (each refused preflight is a console error in the browser).
  let relayOpen = store.get(KEYS.relayOpen) === "1";

  function connectionTarget(conn) {
    if (conn.mode === "default") {
      return { mode: "default", base: workbenchURL, headers: { "X-Hermes-Workbench": "1" }, relayListOnly: !relayOpen };
    }
    const base = Core.normalizeBase(conn.url);
    const headers = { Authorization: "Bearer " + conn.key };
    const hint = () => networkHint(base);
    if (!localProxy()) return { mode: "custom", base, headers, networkHint: hint };
    headers["X-Hermes-Base"] = base;
    return { mode: "custom", base: "/proxy", headers, networkHint: hint };
  }

  let clientCache = null;
  function api() {
    if (!clientCache || clientCache.generation !== state.generation) {
      clientCache = { generation: state.generation, client: Core.createClient(connectionTarget(state.conn)) };
    }
    return clientCache.client;
  }

  function connKey() {
    if (state.conn.mode === "default") return "default " + workbenchURL;
    try { return "custom " + Core.normalizeBase(state.conn.url); } catch { return "custom"; }
  }

  function connectionName() {
    if (state.conn.mode === "default") return "默认连接";
    return state.conn.name || Core.hostOf(state.conn.url) || "自定义连接";
  }

  function connectionDetail() {
    if (state.conn.mode === "default") return Core.hostOf(workbenchURL) + " · Tailscale";
    return Core.hostOf(state.conn.url);
  }

  function anySending() {
    return Array.from(state.conversations.values()).some((conv) => conv.isSending);
  }

  /** Called after the active connection changes: everything server-side is reloaded. */
  function applyConnection() {
    for (const conv of state.conversations.values()) if (conv.abort) conv.abort.abort();
    state.generation++;
    state.remote = newRemoteState();
    state.jobs = newJobsState(state.jobs);
    state.conversations = new Map();
    state.currentKey = null;
    state.drafts = new Map();
    state.models = [];
    state.outcomes = loadOutcomes();
    state.connStatus = connectionValid() ? "checking" : "unconfigured";
    if (connectionValid()) checkConnection();
  }

  function persistConnection() {
    store.set(KEYS.mode, state.conn.mode);
    if (state.conn.url && state.conn.key) {
      store.set(KEYS.url, state.conn.url);
      store.set(KEYS.key, state.conn.key);
      if (state.conn.name) store.set(KEYS.name, state.conn.name); else store.remove(KEYS.name);
    }
  }

  async function checkConnection() {
    const generation = state.generation;
    state.connStatus = "checking";
    try {
      const models = await api().models();
      if (generation !== state.generation) return;
      state.models = models;
      state.connStatus = "connected";
    } catch {
      if (generation !== state.generation) return;
      state.connStatus = "offline";
    }
    render();
  }

  // ------------------------------------------------------------------ inbox results (this tab only)

  function loadOutcomes() {
    try {
      const all = JSON.parse(sessionStorage.getItem(OUTCOMES_KEY) || "[]");
      return Array.isArray(all) ? all.filter((item) => item && item.conn === connKey()) : [];
    } catch { return []; }
  }

  function saveOutcomes() {
    try {
      const others = JSON.parse(sessionStorage.getItem(OUTCOMES_KEY) || "[]").filter((item) => item && item.conn !== connKey());
      sessionStorage.setItem(OUTCOMES_KEY, JSON.stringify(others.concat(state.outcomes).slice(-60)));
    } catch { /* storage unavailable: results stay in memory */ }
  }

  function recordOutcome(conv, kind, title, detail) {
    const id = (kind === "finished" ? "finished:" : "failed:") + (conv.runId || conv.activeSessionId);
    state.outcomes = state.outcomes.filter((item) => item.id !== id);
    state.outcomes.unshift({ id, conn: connKey(), kind, title, detail, sessionId: conv.activeSessionId,
      sessionTitle: Core.sessionTitle(conv.session), createdAt: Date.now() });
    state.outcomes = state.outcomes.slice(0, 30);
    saveOutcomes();
  }

  function dismissOutcome(id) {
    state.outcomes = state.outcomes.filter((item) => item.id !== id);
    saveOutcomes();
    render();
  }

  /** Approvals exist only while their stream is open in this tab; closing the stream ends the run. */
  function inboxApprovals() {
    const items = [];
    for (const conv of state.conversations.values()) {
      for (const approval of conv.approvals) items.push({ approval, conv, createdAt: approval.createdAt });
    }
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  function attentionJobs() {
    return state.jobs.list.filter(Core.jobIsAttention);
  }

  // ------------------------------------------------------------------ server sessions

  function sessionActionsDisabled() {
    const r = state.remote;
    return r.loading || r.loadingMore || r.busyId != null;
  }

  async function reloadSessions() {
    const r = state.remote;
    if (!connectionValid() || r.busyId) return;
    const generation = ++r.generation;
    r.loading = true;
    r.loadingMore = false;
    r.error = null;
    render();
    try {
      const page = await api().sessions(0);
      if (generation !== r.generation || r !== state.remote) return;
      r.sessions = Core.mergeSessions([], page.data);
      r.hasMore = page.hasMore;
      r.nextOffset = 50; // pinned sessions may be back-filled beyond the first 50 rows
      r.updatedAt = new Date();
      r.loaded = true;
      syncConversationSessions();
      const current = currentConversation();
      if (current) requestSessionMeta(current);
    } catch (error) {
      if (generation === r.generation && r === state.remote) r.error = error;
    } finally {
      if (generation === r.generation && r === state.remote) { r.loading = false; render(); }
    }
  }

  async function loadMoreSessions() {
    const r = state.remote;
    if (sessionActionsDisabled() || !r.hasMore) return;
    const generation = r.generation;
    r.loadingMore = true;
    r.error = null;
    render();
    try {
      const page = await api().sessions(r.nextOffset);
      if (generation !== r.generation || r !== state.remote) return;
      r.sessions = Core.mergeSessions(r.sessions, page.data);
      r.hasMore = page.hasMore;
      r.nextOffset += 50;
      r.updatedAt = new Date();
    } catch (error) {
      if (generation === r.generation && r === state.remote) r.error = error;
    } finally {
      if (generation === r.generation && r === state.remote) { r.loadingMore = false; render(); }
    }
  }

  function syncConversationSessions() {
    for (const conv of state.conversations.values()) {
      const session = state.remote.sessions.find((item) => item.id === conv.activeSessionId);
      if (session) conv.session = session;
    }
  }

  async function togglePin(id) {
    const r = state.remote;
    const session = r.sessions.find((item) => item.id === id);
    if (!session || session.pinned == null || sessionActionsDisabled()) return;
    r.busyId = id;
    render();
    try {
      const updated = await api().setSessionPinned(id, session.pinned !== true);
      if (r === state.remote) r.sessions = Core.mergeSessions(r.sessions, [Core.mergePinned(session, updated)]);
    } catch (error) {
      showAlert("服务端操作失败", error.message);
    } finally {
      if (r === state.remote) r.busyId = null;
      render();
    }
  }

  function newSessionDialog() {
    if (sessionActionsDisabled()) return;
    openModal({
      kind: "prompt", title: "新建服务端会话", message: "消息会保存在 Hermes 服务器上，可从其他客户端继续。",
      label: "标题（可选）", value: "", confirmLabel: "创建",
      async onConfirm(value) {
        const r = state.remote;
        r.busyId = "new";
        try {
          const created = await api().createSession(value.trim());
          if (r === state.remote) r.sessions = Core.mergeSessions(r.sessions, [created]);
          closeModal();
          go("#/sessions/" + encodeURIComponent(created.id));
        } finally {
          if (r === state.remote) r.busyId = null;
        }
      }
    });
  }

  // ------------------------------------------------------------------ conversations

  let convSeq = 0;

  class Conversation {
    constructor(session) {
      this.key = "c" + (++convSeq);
      this.session = session;
      this.activeSessionId = session.id;
      this.messages = [];
      this.loaded = false;
      this.loadError = null;
      this.isLoading = false;
      this.isLoadingOlder = false;
      this.hasOlder = false;
      this.nextOffset = 0;
      this.isSending = false;
      this.isStopping = false;
      this.approvalBusy = false;
      this.approvals = [];
      this.transientInput = null;
      this.transientImage = null;
      this.pendingImage = null;
      this.loadingPhoto = false;
      this.streamedReply = "";
      this.progress = "";
      this.error = "";
      this.runId = null;
      this.abort = null;
      this.revision = "";
      this.revisionOverridesRestore = false;
      this.follow = true;
      this.anchor = null;
      this.jumpTo = null;
      this.highlight = null;
      this.searchOpen = false;
      this.searchQuery = "";
      this.expanded = new Set();
      this.metaRequested = false;
    }

    get canSend() { return !this.isSending && !this.isLoading && !this.isLoadingOlder; }
    get draft() { return state.drafts.get(this.activeSessionId) || ""; }
    set draft(value) {
      if (value) state.drafts.set(this.activeSessionId, value);
      else state.drafts.delete(this.activeSessionId);
    }
    get visibleMessages() { return this.messages.filter(Core.messageIsVisible); }
  }

  function findConversation(id) {
    for (const conv of state.conversations.values()) {
      if (conv.activeSessionId === id || conv.session.id === id) return conv;
    }
    return null;
  }

  function currentConversation() {
    return state.currentKey ? state.conversations.get(state.currentKey) || null : null;
  }

  function setActiveSessionId(conv, id) {
    if (!id || id === conv.activeSessionId) return;
    const draft = conv.draft;
    state.drafts.delete(conv.activeSessionId);
    conv.activeSessionId = id;
    if (draft) conv.draft = draft;
    if (state.currentKey === conv.key && state.route.name === "session" && state.route.id !== id) {
      state.route = { name: "session", id };
      history.replaceState(null, "", "#/sessions/" + encodeURIComponent(id));
    }
  }

  /** Keep running conversations (their approvals live in the inbox) and a few recent ones. */
  function pruneConversations() {
    const keep = Array.from(state.conversations.values()).filter((conv) => conv.isSending || conv.key === state.currentKey);
    const recent = Array.from(state.conversations.values()).filter((conv) => !keep.includes(conv)).slice(-4);
    state.conversations = new Map(keep.concat(recent).map((conv) => [conv.key, conv]));
  }

  function enterSession(id, stub) {
    let conv = findConversation(id);
    if (!conv) {
      const session = state.remote.sessions.find((item) => item.id === id) || Object.assign(Core.normalizeSession({ id }), stub || {});
      conv = new Conversation(session);
      state.conversations.set(conv.key, conv);
    }
    state.currentKey = conv.key;
    conv.follow = true;
    pruneConversations();
    if (!conv.isSending) reloadConversation(conv);
    if (state.remote.loaded) requestSessionMeta(conv);
  }

  /** A session outside the loaded pages (opened from the inbox or a link) is read by id once. */
  function requestSessionMeta(conv) {
    if (conv.metaRequested || state.remote.sessions.some((item) => item.id === conv.activeSessionId)) return;
    conv.metaRequested = true;
    api().session(conv.activeSessionId).then((session) => { conv.session = session; render(); }).catch(() => { /* title stays as known */ });
  }

  async function refreshLatest(conv, expected) {
    if (conv.activeSessionId !== expected) return false;
    const page = await api().messages(expected, 0);
    if (conv.activeSessionId !== expected) return false;
    conv.messages = page.data;
    conv.nextOffset = page.returned;
    conv.hasOlder = page.hasMore;
    conv.loaded = true;
    conv.loadError = null;
    if (page.sessionId && page.sessionId !== conv.activeSessionId) setActiveSessionId(conv, page.sessionId);
    conv.transientInput = null;
    conv.transientImage = null;
    conv.streamedReply = "";
    return true;
  }

  async function reloadConversation(conv) {
    if (!conv.canSend) return;
    conv.isLoading = true;
    render();
    try {
      await refreshLatest(conv, conv.activeSessionId);
      conv.progress = "";
    } catch (error) {
      if (conv.loaded) conv.error = error.message;
      else conv.loadError = error;
    } finally {
      conv.isLoading = false;
      render();
    }
  }

  async function loadOlder(conv) {
    if (!conv.canSend || !conv.hasOlder) return;
    const timeline = app.querySelector(".timeline");
    const first = timeline && timeline.querySelector("[data-mid]");
    if (first) conv.anchor = { id: first.dataset.mid, offset: first.getBoundingClientRect().top - timeline.getBoundingClientRect().top };
    conv.follow = false;
    conv.isLoadingOlder = true;
    render();
    try {
      const page = await api().messages(conv.activeSessionId, conv.nextOffset);
      const known = new Set(conv.messages.map((message) => message.id));
      conv.messages = page.data.filter((message) => !known.has(message.id)).concat(conv.messages);
      conv.nextOffset += page.returned;
      conv.hasOlder = page.hasMore;
      if (page.sessionId) setActiveSessionId(conv, page.sessionId);
    } catch (error) {
      conv.anchor = null;
      conv.error = error.message;
    } finally {
      conv.isLoadingOlder = false;
      render();
    }
  }

  function canSendMessage(conv) {
    return conv.canSend && !conv.loadingPhoto && (conv.draft.trim() !== "" || Boolean(conv.pendingImage));
  }

  async function sendMessage(conv) {
    const input = conv.draft.trim();
    const image = conv.pendingImage;
    if (!conv.canSend || conv.loadingPhoto || (!input && !image)) return;
    const sessionAtSend = conv.activeSessionId;
    const knownIds = new Set(conv.messages.map((message) => message.id));
    const controller = new AbortController();
    conv.pendingImage = null;
    conv.draft = "";
    conv.isSending = true;
    conv.isStopping = false;
    conv.transientInput = input || null;
    conv.transientImage = image;
    conv.streamedReply = "";
    conv.progress = "Hermes 正在思考…";
    conv.approvals = [];
    conv.runId = null;
    conv.error = "";
    conv.follow = true;
    conv.abort = controller;
    render();
    try {
      const result = await api().streamSession(sessionAtSend, input, image, (event) => receive(conv, event), controller.signal);
      if (conv.activeSessionId !== sessionAtSend && conv.activeSessionId !== result.sessionId) {
        conv.transientInput = null;
        conv.transientImage = null;
        return;
      }
      setActiveSessionId(conv, result.sessionId);
      conv.streamedReply = result.content;
      conv.progress = "回复已完成";
      recordOutcome(conv, "finished", "回复已完成", Core.snippet(result.content));
      try {
        await refreshLatest(conv, result.sessionId);
        conv.progress = "";
      } catch {
        conv.error = "回复已完成，但记录刷新失败。请点按刷新。";
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error.kind === "sessionCancelled") {
        conv.progress = "已停止";
        conv.transientInput = null;
        conv.transientImage = null;
        return;
      }
      recordOutcome(conv, "failed", "回复失败", Core.snippet(error.message));
      conv.error = error.message;
      conv.progress = "回复未完成，请刷新确认服务端记录";
      let applied = false;
      try { applied = await refreshLatest(conv, sessionAtSend); } catch { applied = false; }
      // Never resend. Whatever the server did not save goes back into the composer.
      const missing = Core.missingParts({ knownIds, messages: conv.messages, input, hadImage: Boolean(image), confirmed: applied });
      if (conv.activeSessionId !== sessionAtSend || missing.text || missing.image) {
        restoreUnsent(conv, missing.text || !applied ? input : "", missing.image || !applied ? image : null);
      }
    } finally {
      conv.isSending = false;
      conv.isStopping = false;
      conv.approvals = [];
      conv.runId = null;
      conv.abort = null;
      conv.revisionOverridesRestore = false;
      if (state.route.name !== "session" || state.currentKey !== conv.key) reloadSessions();
      render();
    }
  }

  function restoreUnsent(conv, input, image) {
    conv.transientInput = null;
    conv.transientImage = null;
    if (!conv.revisionOverridesRestore && input) {
      const draft = conv.draft;
      if (!draft) conv.draft = input;
      else if (draft !== input) {
        conv.draft = input + "\n\n" + draft;
        conv.error = "发送失败：已保留原输入和你新写的草稿，请检查后再发送。";
      }
    }
    conv.pendingImage = image;
  }

  function receive(conv, event) {
    switch (event.type) {
      case "started": conv.runId = event.runId; return;
      case "delta":
        conv.streamedReply += event.text;
        patchLive(conv);
        return;
      case "progress":
      case "commentary":
        conv.progress = event.text;
        patchProgress(conv);
        return;
      case "sessionChanged":
        setActiveSessionId(conv, event.id);
        break;
      case "approval":
        if (!conv.approvals.some((item) => item.id === event.approval.id)) {
          conv.approvals.push(Object.assign({ createdAt: Date.now() }, event.approval));
        }
        conv.progress = "需要你的审批";
        break;
      default: return;
    }
    scheduleRender();
  }

  async function stopRun(conv) {
    if (!conv.isSending || conv.isStopping) return false;
    if (!conv.runId) {
      conv.pendingImage = conv.transientImage;
      if (conv.abort) conv.abort.abort();
      conv.progress = "已取消连接，请刷新确认记录";
      render();
      return true;
    }
    conv.isStopping = true;
    render();
    try {
      await api().stopRun(conv.runId);
      conv.progress = "正在停止…";
      return true;
    } catch (error) {
      conv.isStopping = false;
      conv.error = error.message;
      return false;
    } finally {
      render();
    }
  }

  async function stopAndRevise(conv) {
    const text = conv.revision.trim();
    if (!text || !(await stopRun(conv))) return;
    if (conv.isSending) conv.revisionOverridesRestore = true;
    conv.draft = text;
    conv.revision = "";
    render();
  }

  function findApproval(id) {
    for (const conv of state.conversations.values()) {
      const approval = conv.approvals.find((item) => item.id === id);
      if (approval) return { conv, approval };
    }
    return null;
  }

  /** origin is "session" or "inbox"; the inbox only accepts choices the server offered. */
  async function resolveApproval(id, choice, origin) {
    const found = findApproval(id);
    if (!found) return;
    const { conv, approval } = found;
    if (origin === "inbox" && !Core.approvalChoiceAllowed(approval, choice)) return;
    if (conv.approvalBusy || conv.isStopping) return;
    conv.approvalBusy = true;
    render();
    try {
      await api().resolveApproval(approval, choice);
      conv.approvals = conv.approvals.filter((item) => item.id !== approval.id);
      if (conv.isSending && conv.approvals.length === 0) conv.progress = Core.approvalProgress(choice);
    } catch (error) {
      if (origin === "inbox") showAlert("收件箱操作失败", "无法提交审批，请稍后再试。" + (error.message ? `\n${error.message}` : ""));
      else conv.error = error.message;
    } finally {
      conv.approvalBusy = false;
      render();
    }
  }

  function confirmElevated(id, choice, origin) {
    state.menu = null;
    openModal({
      kind: "confirm", title: "确认扩大授权范围？",
      message: "请先核对卡片中展示的完整命令；此授权可能对后续操作生效。",
      confirmLabel: choice === "always" ? "确认始终允许" : "确认本会话允许", danger: true,
      async onConfirm() { closeModal(); await resolveApproval(id, choice, origin); }
    });
  }

  function renameDialog(conv) {
    if (!conv.canSend) return;
    openModal({
      kind: "prompt", title: "重命名服务端会话", label: "标题", value: conv.session.title || "", confirmLabel: "保存", required: true,
      async onConfirm(value) {
        const title = value.trim();
        if (!title) return;
        const session = await api().renameSession(conv.activeSessionId, title);
        conv.session = session;
        state.remote.sessions = Core.mergeSessions(state.remote.sessions, [session]);
        closeModal();
      }
    });
  }

  function deleteDialog(conv) {
    if (!conv.canSend) return;
    openModal({
      kind: "confirm", title: `删除“${Core.sessionTitle(conv.session)}”及其服务端消息？`,
      message: "会话和消息会从 Hermes 服务器删除。", confirmLabel: "删除", danger: true,
      async onConfirm() {
        await api().deleteSession(conv.activeSessionId);
        state.drafts.delete(conv.activeSessionId);
        state.remote.sessions = state.remote.sessions.filter((item) => item.id !== conv.activeSessionId);
        state.conversations.delete(conv.key);
        state.currentKey = null;
        closeModal();
        go("#/sessions");
        reloadSessions();
      }
    });
  }

  // ------------------------------------------------------------------ images

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("无法读取这张图片。")); };
      image.src = url;
    });
  }

  function canvasJPEG(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  function blobDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("无法读取这张图片。"));
      reader.readAsDataURL(blob);
    });
  }

  /** Like ImageAttachmentStore.prepare: longest side 1600, JPEG 0.72, then 0.48, at most 2 MB. */
  async function prepareImage(file) {
    if (!file || !/^image\//.test(file.type || "image/")) throw new Error("无法读取这张图片。");
    const image = await readImage(file);
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    if (!longest) throw new Error("无法读取这张图片。");
    const ratio = Math.min(1, 1600 / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let blob = await canvasJPEG(canvas, 0.72);
    if (!blob) throw new Error("无法读取这张图片。");
    if (blob.size > 2000000) {
      blob = await canvasJPEG(canvas, 0.48);
      if (!blob || blob.size > 2000000) throw new Error("图片压缩后仍超过 2 MB，请选择较小的图片。");
    }
    const dataURL = await blobDataURL(blob);
    return "data:image/jpeg;base64," + String(dataURL).split(",")[1];
  }

  async function attachImage(conv, file) {
    if (!conv.canSend) { conv.error = "正在读取或发送，请稍后再添加图片。"; render(); return; }
    const sessionId = conv.activeSessionId;
    conv.loadingPhoto = true;
    render();
    try {
      const prepared = await prepareImage(file);
      if (conv.activeSessionId === sessionId) conv.pendingImage = prepared;
    } catch (error) {
      if (conv.activeSessionId === sessionId) conv.error = error.message;
    } finally {
      conv.loadingPhoto = false;
      render();
    }
  }

  // ------------------------------------------------------------------ scheduled jobs

  function jobActionsDisabled() {
    const j = state.jobs;
    return j.loading || j.busyId != null || j.refreshingId != null;
  }

  async function reloadJobs() {
    const j = state.jobs;
    if (!connectionValid() || j.busyId || j.refreshingId) return;
    const generation = ++j.generation;
    j.loading = true;
    j.error = null;
    render();
    try {
      const list = await api().jobs();
      if (generation !== j.generation || j !== state.jobs) return;
      j.list = Core.dedupeJobs(list);
      j.loaded = true;
      j.updatedAt = new Date();
    } catch (error) {
      if (generation === j.generation && j === state.jobs) j.error = error;
    } finally {
      if (generation === j.generation && j === state.jobs) { j.loading = false; render(); }
    }
  }

  function updateJob(job) {
    const j = state.jobs;
    const index = j.list.findIndex((item) => item.id === job.id);
    if (index >= 0) j.list[index] = job;
    else j.list.push(job);
  }

  async function refreshJob(id) {
    const j = state.jobs;
    if (jobActionsDisabled()) return;
    j.refreshingId = id;
    j.detailError = null;
    render();
    try {
      const job = await api().job(id);
      if (j === state.jobs) updateJob(job);
    } catch (error) {
      if (j === state.jobs) j.detailError = error;
    } finally {
      if (j === state.jobs) j.refreshingId = null;
      render();
    }
  }

  async function jobAction(id, action) {
    const j = state.jobs;
    const job = j.list.find((item) => item.id === id);
    if (!job || jobActionsDisabled()) return false;
    j.busyId = id;
    if (action === "run") { j.notice = ""; j.detailError = null; }
    render();
    try {
      if (action === "toggle") updateJob(await api().setJobPaused(id, !Core.jobIsPaused(job)));
      if (action === "delete") {
        await api().deleteJob(id);
        j.list = j.list.filter((item) => item.id !== id);
      }
      if (action === "run") {
        await api().runJob(id);
        j.notice = `已提交“${job.name}”的运行请求，请刷新查看结果。`;
        try {
          j.list = Core.dedupeJobs(await api().jobs());
          j.updatedAt = new Date();
          j.error = null;
        } catch (error) {
          const message = { message: "运行请求已提交，但刷新失败：" + error.message, kind: error.kind };
          j.error = message;
          j.detailError = message;
        }
      }
      return true;
    } catch (error) {
      showAlert("服务端操作失败", error.message);
      return false;
    } finally {
      if (j === state.jobs) j.busyId = null;
      render();
    }
  }

  function jobEditor(job, copying) {
    const values = job ? (copying ? Core.jobCopyDraft(job) : { name: job.name, prompt: job.prompt ?? "", schedule: Core.jobEditableSchedule(job) })
      : { name: "", prompt: "", schedule: "every 1h" };
    openModal({ kind: "jobEditor", job: job || null, copying: Boolean(copying), values, saving: false });
  }

  async function saveJobEditor() {
    const modal = state.modal;
    if (!modal || modal.kind !== "jobEditor" || modal.saving) return;
    const { job, copying, values } = modal;
    if (!Core.jobEditorCanSave(values, job, copying)) return;
    const fields = Core.jobEditorFields(values, job, copying);
    modal.saving = true;
    modal.error = "";
    render();
    try {
      if (job && !copying) {
        updateJob(await api().updateJob(job.id, fields));
        closeModal();
        refreshJob(job.id);
      } else {
        const created = await api().createJob(fields);
        closeModal();
        await reloadJobs();
        if (copying && created) go("#/jobs/" + encodeURIComponent(created.id));
      }
    } catch (error) {
      if (state.modal === modal) { modal.saving = false; modal.error = error.message; render(); }
    }
  }

  // Polls only while the job list is visible, the tab is in front and no dialog is open.
  const poll = { key: "", timer: null, failures: 0 };

  function updatePoller() {
    const j = state.jobs;
    const active = state.route.name === "jobs" && document.visibilityState === "visible" && !state.modal &&
      connectionValid() && j.refreshSeconds > 0;
    const key = active ? `${state.generation}:${j.refreshSeconds}` : "";
    if (key === poll.key) return;
    clearTimeout(poll.timer);
    poll.key = key;
    poll.timer = null;
    poll.failures = 0;
    if (key) schedulePoll(key);
  }

  function schedulePoll(key) {
    poll.timer = setTimeout(async () => {
      if (poll.key !== key) return;
      if (!jobActionsDisabled()) {
        await reloadJobs();
        poll.failures = state.jobs.error ? Math.min(3, poll.failures + 1) : 0;
      }
      if (poll.key === key) schedulePoll(key);
    }, Core.refreshDelay(state.jobs.refreshSeconds, poll.failures) * 1000);
  }

  // ------------------------------------------------------------------ settings and pairing

  function editConnection() {
    state.form = { name: state.conn.name, url: state.conn.url, key: state.conn.key, busy: false, feedback: "", ok: false, models: [] };
    render();
    requestAnimationFrame(() => document.getElementById("formName")?.focus());
  }

  function formConnection() {
    const form = state.form;
    const conn = { mode: "custom", name: form.name.trim(), url: form.url.trim(), key: form.key.trim() };
    if (!conn.key) throw new Error("请填写 API 密钥");
    Core.normalizeBase(conn.url);
    return conn;
  }

  async function testForm() {
    const form = state.form;
    if (!form || form.busy) return;
    let conn;
    try { conn = formConnection(); } catch (error) { form.feedback = error.message; form.ok = false; render(); return; }
    form.busy = true;
    form.feedback = "正在测试连接…";
    form.ok = true;
    render();
    try {
      const models = await Core.createClient(connectionTarget(conn)).models();
      form.models = models;
      form.ok = true;
      form.feedback = models.length ? `已连接，服务器公布 ${models.length} 个模型名称。` : "已连接，服务器没有公布模型名称。";
    } catch (error) {
      form.ok = false;
      form.feedback = error.message;
    } finally {
      form.busy = false;
      render();
    }
  }

  function saveForm() {
    const form = state.form;
    if (!form || form.busy) return;
    if (anySending()) { form.feedback = "回复进行中，停止或完成后即可修改连接。"; form.ok = false; render(); return; }
    let conn;
    try { conn = formConnection(); } catch (error) { form.feedback = error.message; form.ok = false; render(); return; }
    state.conn = conn;
    persistConnection();
    state.form = null;
    applyConnection();
    toast(`已保存“${connectionName()}”`);
    go("#/");
  }

  function useConnection(mode) {
    if (mode === state.conn.mode) return;
    if (anySending()) { showAlert("暂时无法切换", "回复进行中，停止或完成后即可切换连接。"); return; }
    if (mode === "custom" && !(state.conn.url && state.conn.key)) { editConnection(); return; }
    state.conn = Object.assign({}, state.conn, { mode });
    store.set(KEYS.mode, mode);
    applyConnection();
    render();
    enterRoute();
  }

  function removeCustomDialog() {
    if (anySending()) { showAlert("暂时无法移除", "回复进行中，停止或完成后即可修改连接。"); return; }
    openModal({
      kind: "confirm", title: `移除“${state.conn.name || Core.hostOf(state.conn.url) || "自定义连接"}”？`,
      message: "会从这个浏览器删除服务地址和 API 密钥。服务器上的会话与任务会保留。", confirmLabel: "移除", danger: true,
      async onConfirm() {
        store.remove(KEYS.url);
        store.remove(KEYS.key);
        store.remove(KEYS.name);
        const mode = workbenchURL ? "default" : "custom";
        store.set(KEYS.mode, mode);
        state.conn = { mode, url: "", key: "", name: "" };
        state.form = null;
        closeModal();
        applyConnection();
        render();
      }
    });
  }

  /** Scanned or pasted text. Returns an error message, or opens the confirmation. */
  function acceptPairing(raw) {
    let payload;
    try { payload = Core.decodePairing(Core.pairingText(raw)); } catch (error) { return error.message || "配对码无效。"; }
    closeScanner();
    openModal({ kind: "pairConfirm", payload, name: payload.name, error: pairingAddressError(payload.url) });
    return "";
  }

  function pairingAddressError(url) {
    try { Core.normalizeBase(url); return ""; } catch (error) { return error.message; }
  }

  function savePairing() {
    const modal = state.modal;
    if (!modal || modal.kind !== "pairConfirm") return;
    if (anySending()) { modal.error = "回复进行中，停止或完成后即可修改连接。"; render(); return; }
    const error = pairingAddressError(modal.payload.url);
    if (error) { modal.error = error; render(); return; }
    state.conn = { mode: "custom", name: modal.name.trim() || modal.payload.name, url: modal.payload.url, key: modal.payload.key };
    persistConnection();
    state.form = null;
    closeModal();
    applyConnection();
    toast(`已保存并切换到“${connectionName()}”`);
    go("#/");
  }

  function scanSupported() {
    return "BarcodeDetector" in window && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  }

  const scanner = { stream: null, timer: null, detector: null, last: null };

  async function qrDetector() {
    if (!("BarcodeDetector" in window)) return null;
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (!formats.includes("qr_code")) return null;
    } catch { return null; }
    return new window.BarcodeDetector({ formats: ["qr_code"] });
  }

  async function openScanner() {
    state.menu = null;
    const detector = scanSupported() ? await qrDetector() : null;
    if (!detector) {
      openModal({ kind: "pairPaste", text: "", error: "", note: "此浏览器不能用相机识别二维码。请粘贴配对码文字，或改用支持扫码的浏览器（如 macOS、Android 上的 Chrome）。" });
      return;
    }
    scanner.detector = detector;
    scanner.last = null;
    overlay.innerHTML = `<div class="scanner" role="dialog" aria-modal="true" aria-label="扫码添加连接">
      <div class="scanner-top"><strong>扫码添加连接</strong><button class="icon-btn on-dark" data-scan="close" aria-label="关闭">${icon("x")}</button></div>
      <div class="scanner-view"><video playsinline muted></video><div class="scanner-frame"></div></div>
      <div class="scanner-status">
        <p class="scanner-error" hidden></p>
        <button class="pill filled tone-accent" data-scan="retry" hidden>重新扫描</button>
        <p>将配对码放入取景框</p>
        <small>相机画面只在这台设备上处理，不会上传。</small>
        <label class="pill tone-neutral on-dark">从图片识别<input type="file" accept="image/*" data-scan="image" hidden></label>
      </div>
    </div>`;
    overlay.hidden = false;
    try {
      scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch (error) {
      const denied = error && (error.name === "NotAllowedError" || error.name === "SecurityError");
      const missing = error && (error.name === "NotFoundError" || error.name === "OverconstrainedError");
      scannerMessage(denied ? "需要相机权限才能扫描配对码。请在浏览器设置中允许使用相机。" : missing ? "此设备没有可用的相机，无法扫码。可以从图片识别或粘贴配对码。" : "无法打开相机。", false);
      return;
    }
    if (!overlay.querySelector(".scanner")) { stopCamera(); return; }
    const video = overlay.querySelector("video");
    video.srcObject = scanner.stream;
    video.play().catch(() => {});
    scanLoop(video);
  }

  function scanLoop(video) {
    scanner.timer = setTimeout(async () => {
      if (!scanner.stream) return;
      try {
        if (video.readyState >= 2) {
          const codes = await scanner.detector.detect(video);
          const value = codes.map((code) => code.rawValue).find(Boolean);
          if (value && value !== scanner.last) {
            scanner.last = value;
            const error = acceptPairing(value);
            if (!error) return;
            scannerMessage(error, true);
          }
        }
      } catch { /* keep scanning */ }
      if (scanner.stream) scanLoop(video);
    }, 250);
  }

  function scannerMessage(text, retry) {
    const error = overlay.querySelector(".scanner-error");
    if (!error) return;
    error.textContent = text;
    error.hidden = !text;
    overlay.querySelector('[data-scan="retry"]').hidden = !retry;
  }

  function stopCamera() {
    clearTimeout(scanner.timer);
    if (scanner.stream) scanner.stream.getTracks().forEach((track) => track.stop());
    scanner.stream = null;
  }

  function closeScanner() {
    stopCamera();
    overlay.hidden = true;
    overlay.innerHTML = "";
  }

  async function decodeImageFile(file) {
    const detector = await qrDetector();
    if (!detector) return "此浏览器不能从图片识别二维码，请粘贴配对码文字。";
    try {
      const bitmap = await createImageBitmap(file);
      const codes = await detector.detect(bitmap);
      const value = codes.map((code) => code.rawValue).find(Boolean);
      if (!value) return "图片中没有找到配对码。";
      return acceptPairing(value);
    } catch {
      return "无法读取这张图片。";
    }
  }

  overlay.addEventListener("click", (event) => {
    const target = event.target.closest("[data-scan]");
    if (!target) return;
    if (target.dataset.scan === "close") closeScanner();
    if (target.dataset.scan === "retry") { scanner.last = null; scannerMessage("", false); }
  });

  overlay.addEventListener("change", async (event) => {
    if (event.target.dataset.scan !== "image" || !event.target.files[0]) return;
    const error = await decodeImageFile(event.target.files[0]);
    event.target.value = "";
    if (error) scannerMessage(error, false);
  });

  // ------------------------------------------------------------------ appearance

  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function applyAppearance() {
    const value = state.appearance;
    if (value === "light" || value === "dark") document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
    const dark = value === "dark" || (value === "system" && darkQuery.matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0B0B0D" : "#F4F4F7");
  }

  darkQuery.addEventListener("change", applyAppearance);

  // ------------------------------------------------------------------ dialogs and notices

  function openModal(modal) {
    state.menu = null;
    state.modal = Object.assign({ busy: false, error: "" }, modal);
    render();
    requestAnimationFrame(() => {
      const field = app.querySelector(".modal [autofocus]") || app.querySelector(".modal input, .modal textarea, .modal button");
      if (field) field.focus();
    });
  }

  function closeModal() {
    state.modal = null;
    render();
  }

  function showAlert(title, message) {
    openModal({ kind: "alert", title, message });
  }

  let toastTimer = null;
  function toast(text) {
    state.toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { state.toast = null; render(); }, 2600);
    render();
  }

  async function copyText(text, done = "已复制") {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      showAlert("无法复制", "浏览器没有允许写入剪贴板。");
    }
  }

  // ------------------------------------------------------------------ routing

  function parseRoute(hash) {
    const parts = String(hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
    const id = parts[1] ? safeDecode(parts[1]) : null;
    switch (parts[0]) {
      case "inbox": return { name: "inbox" };
      case "sessions": return id ? { name: "session", id } : { name: "sessions" };
      case "jobs": return id ? { name: "job", id } : { name: "jobs" };
      case "settings": return { name: "settings" };
      default: return { name: "home" };
    }
  }

  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch { return value; }
  }

  function go(hash) {
    if (location.hash === hash) onRoute();
    else location.hash = hash;
  }

  let previousRoute = null;
  function onRoute() {
    previousRoute = state.route;
    state.route = parseRoute(location.hash);
    state.menu = null;
    enterRoute();
    render();
  }

  /** Loads what a page needs, like the iOS views do when they appear. */
  function enterRoute() {
    const route = state.route;
    if (previousRoute && previousRoute.name === "session" && route.name !== "session") reloadSessions();
    if (!connectionValid()) return;
    const r = state.remote;
    if (route.name !== "session") state.currentKey = null;
    switch (route.name) {
      case "home":
        if (!r.loaded && !r.loading) reloadSessions();
        reloadJobs();
        break;
      case "inbox":
        reloadJobs();
        break;
      case "sessions":
        if (!r.loaded && !r.loading) reloadSessions();
        break;
      case "session": {
        if (!r.loaded && !r.loading) reloadSessions();
        const outcome = state.outcomes.find((item) => item.sessionId === route.id);
        enterSession(route.id, outcome ? { title: outcome.sessionTitle } : null);
        break;
      }
      case "jobs":
        reloadJobs();
        break;
      case "job":
        refreshJob(route.id);
        break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ rendering

  const ICONS = {
    home: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
    chats: '<path d="M4 4.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9.5L5.5 18v-3.5H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z"/><path d="M20 9a2 2 0 0 1 2 2v5.5a2 2 0 0 1-2 2h-1V21l-3.5-2.5H12"/>',
    jobs: '<rect x="3" y="4.5" width="13" height="13" rx="2"/><path d="M7 3v3M12 3v3M3 9h13"/><circle cx="17.5" cy="17" r="4.5"/><path d="M17.5 15v2.3l1.5 1"/>',
    settings: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    chevronRight: '<path d="M9 5.5l6.5 6.5L9 18.5"/>',
    chevronLeft: '<path d="M15 5.5L8.5 12l6.5 6.5"/>',
    chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
    arrowUp: '<path d="M12 19V5.5M6 11.5l6-6 6 6"/>',
    arrowDown: '<path d="M12 5v13.5M6 12.5l6 6 6-6"/>',
    arrowUpRight: '<path d="M7.5 16.5l9-9M9 7.5h7.5V15"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    image: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.7"/><path d="M21 15.5l-5-5-9.5 9"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
    pin: '<path d="M9.5 3.5h5l-.8 5.2 3.3 3.3v2H7v-2l3.3-3.3-.8-5.2zM12 14v6.5"/>',
    refresh: '<path d="M19.5 10a7.5 7.5 0 0 0-13.6-3.3L4.5 8.5M4.5 4v4.5H9M4.5 14a7.5 7.5 0 0 0 13.6 3.3l1.4-1.8M19.5 20v-4.5H15"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>',
    pencil: '<path d="M4.5 19.5h4l10-10-4-4-10 10v4zM13 7l4 4"/>',
    copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
    more: '<circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    hand: '<path d="M8.5 12.5V6a1.5 1.5 0 0 1 3 0v5M11.5 10.5V4.8a1.5 1.5 0 0 1 3 0v5.7M14.5 10.5V6.5a1.5 1.5 0 0 1 3 0V14a6.5 6.5 0 0 1-6.5 6.5h-.6a5.5 5.5 0 0 1-4.7-2.6l-2.3-3.6a1.5 1.5 0 0 1 2.5-1.7l1.6 2"/>',
    alert: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4.2M12 17h.01"/>',
    play: '<path d="M8.5 5.5v13l10-6.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
    bolt: '<path d="M13 3L5.5 13.5h6L10.5 21 18 10.5h-6z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 19.5V20M19.5 14h.5"/>',
    scan: '<path d="M4 8.5V5a1 1 0 0 1 1-1h3.5M15.5 4H19a1 1 0 0 1 1 1v3.5M20 15.5V19a1 1 0 0 1-1 1h-3.5M8.5 20H5a1 1 0 0 1-1-1v-3.5M7 12h10"/>',
    paste: '<rect x="5.5" y="4.5" width="13" height="16" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h4"/>',
    wrench: '<path d="M14.5 5.5a4 4 0 0 0 4.8 5.2l-8.6 8.6a2.2 2.2 0 0 1-3.1-3.1l8.6-8.6a4 4 0 0 0-1.7-2.1z"/><path d="M14.5 5.5l2-2 4 4-2 2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    inbox: '<path d="M3.5 13.5l2.8-8h11.4l2.8 8v5.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1z"/><path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/>',
    offline: '<path d="M3 3l18 18M9 16a4.5 4.5 0 0 1 6 0M5.5 12.5a9.5 9.5 0 0 1 4-2.2M18.5 12.5a9.4 9.4 0 0 0-2.3-1.6M2.5 9a14 14 0 0 1 4-2.6M21.5 9A14 14 0 0 0 11 5.5M12 19.5h.01"/>',
    key: '<circle cx="8" cy="15.5" r="4"/><path d="M11 12.5l9-9M16.5 6l3 3M14 8.5l2 2"/>',
    contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/>',
    checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.8 2.8L16 9.8"/>',
    xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    undo: '<path d="M9 14L4.5 9.5 9 5M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'
  };

  function icon(name, cls = "") {
    return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  const mark = (size) => `<span class="mark" style="--size:${size}px" aria-hidden="true">H</span>`;
  const spinner = (cls = "") => `<span class="spinner ${cls}" aria-hidden="true"></span>`;
  const badge = (text, tone = "accent", iconName) => `<span class="badge tone-${tone}">${iconName ? icon(iconName) : ""}${esc(text)}</span>`;
  const dot = (tone) => `<span class="dot tone-${tone}" aria-hidden="true"></span>`;
  const tile = (name, tone, size = 34) => `<span class="tile tone-${tone}" style="--size:${size}px" aria-hidden="true">${icon(name)}</span>`;
  const origin = () => `<span class="origin">${icon("server")}服务端</span>`;
  const enc = encodeURIComponent;
  const sessionHref = (id) => "#/sessions/" + enc(id);
  const jobHref = (id) => "#/jobs/" + enc(id);

  const mdCache = new Map();
  function markdown(text) {
    let html = mdCache.get(text);
    if (html == null) {
      html = Core.renderMarkdown(text);
      if (mdCache.size > 500) mdCache.clear();
      mdCache.set(text, html);
    }
    return html;
  }

  function relative(timeMs) {
    return Core.relativeTime(new Date(timeMs));
  }

  function sectionTitle(title, count, trailing, trailingHref) {
    return `<div class="section-title"><h2>${esc(title)}${count ? `<span class="count">${count}</span>` : ""}</h2>` +
      (trailing ? `<a class="section-link" href="${trailingHref}">${esc(trailing)}${icon("chevronRight")}</a>` : "") + "</div>";
  }

  function errorText(error) {
    return error ? (error.message || String(error)) : "";
  }

  function loadBanner(error, hasRecords, act, disabled, prefix = "") {
    const relay = error && error.kind === "relayRoute";
    if (relay) {
      return `<div class="card banner tone-info" role="status">
        <div class="banner-title">${icon("info")}<span>默认连接暂不支持</span></div>
        <p>${esc(errorText(error))}</p>
        <button class="link-btn" data-act="relay-try" data-retry="${act}" ${disabled ? "disabled" : ""}>中继已更新？仍然尝试</button>
      </div>`;
    }
    const title = relay ? "默认连接暂不支持" : hasRecords ? "刷新失败，保留上次记录" : "读取失败";
    return `<div class="card banner ${relay ? "tone-info" : "tone-warning"}" role="status">
      <div class="banner-title">${icon(relay ? "info" : "offline")}<span>${title}</span></div>
      <p>${esc(prefix + errorText(error))}</p>
      <button class="link-btn" data-act="${act}" ${disabled ? "disabled" : ""}>重试</button>
    </div>`;
  }

  function updatedRow(date) {
    return date ? `<p class="updated">最近刷新 ${esc(Core.clockTime(date))}</p>` : "";
  }

  function emptyState(iconName, title, text) {
    return `<div class="empty-state">${icon(iconName)}<strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ""}</div>`;
  }

  // ---- shell

  function shell() {
    const configured = connectionValid();
    const route = state.route;
    const split = configured && (route.name === "session" || route.name === "sessions");
    const chat = configured && route.name === "session";
    let view;
    if (!configured) view = settingsView(true);
    else if (split) view = sessionsSplit(route);
    else if (route.name === "home") view = homeView();
    else if (route.name === "inbox") view = inboxView();
    else if (route.name === "jobs") view = jobsView();
    else if (route.name === "job") view = jobView(route.id);
    else view = settingsView(false);
    const scrollKey = split ? "" : ` data-scroll="main:${configured ? route.name : "setup"}"`;
    return `<div class="shell${chat ? " is-chat" : ""}${split ? " is-split" : ""}">
      ${sidebar(configured)}
      <main class="main" id="main"${scrollKey}>${view}</main>
      ${chat || !configured ? "" : tabbar()}
      ${modalView()}
      ${state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : ""}
    </div>`;
  }

  function navItems() {
    const approvals = inboxApprovals().length;
    const name = state.route.name;
    return [
      { href: "#/", label: "工作台", icon: "home", active: name === "home" || name === "inbox", badge: approvals },
      { href: "#/sessions", label: "对话", icon: "chats", active: name === "sessions" || name === "session" },
      { href: "#/jobs", label: "定时任务", icon: "jobs", active: name === "jobs" || name === "job" },
      { href: "#/settings", label: "设置", icon: "settings", active: name === "settings" }
    ];
  }

  function statusInfo() {
    switch (state.connStatus) {
      case "connected": return { title: "已连接", tone: "success" };
      case "checking": return { title: "检测中", tone: "info" };
      case "offline": return { title: "连接失败", tone: "danger" };
      default: return { title: "未配置", tone: "warning" };
    }
  }

  function sidebar(configured) {
    const status = statusInfo();
    const items = configured ? navItems().map((item) => `<a class="nav-item${item.active ? " active" : ""}" href="${item.href}"${item.active ? ' aria-current="page"' : ""}>${icon(item.icon)}<span>${item.label}</span>${item.badge ? `<span class="nav-badge" aria-label="${item.badge} 个待审批">${item.badge}</span>` : ""}</a>`).join("") : "";
    return `<aside class="sidebar">
      <div class="brand">${mark(34)}<div><strong>Hermes</strong><small>信使 · Web ${esc(Core.VERSION)}</small></div></div>
      <nav class="side-nav" aria-label="主导航">${items}</nav>
      ${configured ? `<a class="side-conn" href="#/settings">${dot(status.tone)}<span class="grow"><strong>${esc(connectionName())}</strong><small>${esc(status.title)}</small></span>${icon("chevronRight")}</a>` : ""}
    </aside>`;
  }

  function tabbar() {
    return `<nav class="tabbar" aria-label="主导航">${navItems().map((item) => `<a class="tab${item.active ? " active" : ""}" href="${item.href}"${item.active ? ' aria-current="page"' : ""}><span class="tab-icon">${icon(item.icon)}${item.badge ? `<span class="nav-badge">${item.badge}</span>` : ""}</span><span>${item.label}</span></a>`).join("")}</nav>`;
  }

  function pageHead(title, actions = "", back = "") {
    return `<header class="page-head">${back ? `<a class="icon-btn back" href="${back}" aria-label="返回">${icon("chevronLeft")}</a>` : ""}<h1>${esc(title)}</h1><div class="head-actions">${actions}</div></header>`;
  }

  // ---- home

  function homeView() {
    const status = statusInfo();
    const recent = state.remote.sessions.slice().sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0)).slice(0, 4);
    const jobs = state.jobs;
    const running = jobs.list.filter(Core.jobIsRunning).length;
    return `<div class="page">
      ${pageHead("工作台")}
      <div class="stack">
        <a class="card conn-card" href="#/settings" aria-label="${esc(connectionName())}，${status.title}，打开连接设置">
          ${mark(40)}
          <span class="grow"><strong>${esc(connectionName())}</strong><small>${esc(connectionDetail())}</small></span>
          <span class="conn-state tone-text-${status.tone}">${dot(status.tone)}${status.title}</span>
          ${icon("chevronRight", "muted")}
        </a>
        <button class="btn primary block" data-act="new-session" ${sessionActionsDisabled() ? "disabled" : ""}>${icon("pencil")}新建服务端会话</button>
      </div>
      ${pendingSection()}
      <section class="section">
        ${sectionTitle("最近会话", 0, "全部", "#/sessions")}
        ${state.remote.error && !state.remote.sessions.length ? loadBanner(state.remote.error, false, "reload-sessions", sessionActionsDisabled()) : ""}
        ${recent.length ? `<div class="group">${recent.map((session) => `<a class="group-row" href="${sessionHref(session.id)}">${tile("server", "info", 30)}<span class="grow"><strong class="ellipsis">${esc(Core.sessionTitle(session))}</strong><small class="ellipsis">${esc(session.preview || session.source || "Hermes")}</small></span><time>${session.lastActive ? esc(relative(session.lastActive * 1000)) : ""}</time></a>`).join("")}</div>`
          : `<div class="card muted-card">${state.remote.loading ? "正在读取服务端会话…" : "还没有服务端会话。新建一段会话，消息会保存在 Hermes 服务器上。"}</div>`}
      </section>
      <section class="section">
        ${sectionTitle("常用")}
        <div class="tiles">
          <a class="card shortcut" href="#/jobs">${tile("jobs", "info")}<strong>定时任务</strong><small>${jobs.loaded ? `${jobs.list.length} 个 · 运行中 ${running}` : jobs.error && jobs.error.kind === "relayRoute" ? "默认连接暂不支持" : "服务端任务"}</small></a>
          <a class="card shortcut" href="#/inbox">${tile("inbox", "accent")}<strong>收件箱</strong><small>待处理 ${Core.pendingCount(inboxApprovals().length, jobs.list)} · 结果 ${state.outcomes.length}</small></a>
        </div>
      </section>
    </div>`;
  }

  function pendingSection() {
    const approvals = inboxApprovals().slice(0, 2);
    const jobs = attentionJobs().slice(0, Math.max(0, 3 - approvals.length));
    const outcomes = state.outcomes.slice(0, Math.max(0, 3 - approvals.length - jobs.length));
    const pending = Core.pendingCount(inboxApprovals().length, state.jobs.list);
    const jobsError = state.jobs.error;
    let body = "";
    if (jobsError) body += loadBanner(jobsError, state.jobs.loaded, "reload-jobs", jobActionsDisabled(), "无法读取定时任务。");
    if (!approvals.length && !jobs.length && !outcomes.length && !jobsError) {
      body += `<div class="card ready-card">${tile(state.jobs.loading ? "refresh" : "check", "success", 32)}<span class="grow"><strong>${state.jobs.loading ? "正在读取…" : "一切就绪"}</strong><small>需要你审批、失败或正在运行的事项会出现在这里。</small></span></div>`;
    }
    body += approvals.map((item) => inboxApprovalCard(item)).join("");
    body += jobs.map(inboxJobRow).join("");
    body += outcomes.map(outcomeRow).join("");
    return `<section class="section">${sectionTitle("待处理", pending, "收件箱", "#/inbox")}<div class="stack">${body}</div></section>`;
  }

  // ---- inbox

  function inboxView() {
    const approvals = inboxApprovals();
    const jobs = attentionJobs();
    const empty = !approvals.length && !jobs.length && !state.outcomes.length;
    return `<div class="page">
      ${pageHead("收件箱", `<button class="icon-btn" data-act="reload-jobs" aria-label="刷新" ${jobActionsDisabled() ? "disabled" : ""}>${state.jobs.loading ? spinner() : icon("refresh")}</button>`, "#/")}
      ${state.jobs.error ? loadBanner(state.jobs.error, state.jobs.loaded, "reload-jobs", jobActionsDisabled(), "无法读取定时任务。") : ""}
      ${empty && !state.jobs.error ? (state.jobs.loading ? `<div class="card muted-card">${spinner()}正在读取收件箱…</div>` : emptyState("checkCircle", "一切就绪", "审批、完成和失败会出现在这里。")) : ""}
      ${approvals.length ? `<section class="section">${sectionTitle("待审批", approvals.length)}<div class="stack">${approvals.map(inboxApprovalCard).join("")}</div></section>` : ""}
      ${jobs.length ? `<section class="section">${sectionTitle("定时任务", jobs.length)}<div class="stack">${jobs.map(inboxJobRow).join("")}</div></section>` : ""}
      ${state.outcomes.length ? `<section class="section">${sectionTitle("最近结果", state.outcomes.length)}<div class="stack">${state.outcomes.map(outcomeRow).join("")}</div>
        <p class="footnote">点按 × 可清除已读结果。收件箱只记录这个浏览器标签页发起并观察到的运行，关闭标签页后清空。</p></section>` : ""}
    </div>`;
  }

  function inboxApprovalCard(item) {
    const { approval, conv } = item;
    return `<div class="approval-wrap">${approvalCard(approval, {
      context: Core.sessionTitle(conv.session), createdAt: approval.createdAt, busy: conv.approvalBusy || conv.isStopping, origin: "inbox"
    })}<a class="open-link" href="${sessionHref(conv.activeSessionId)}">打开会话${icon("arrowUpRight")}</a></div>`;
  }

  function inboxJobRow(job) {
    const running = Core.jobIsRunning(job);
    const showLast = !running || (job.lastStatus != null && job.lastStatus !== "running");
    return `<a class="card row-card" href="${jobHref(job.id)}">${tile(running ? "play" : "alert", running ? "info" : "warning", 32)}
      <span class="grow"><span class="row-top"><strong class="clamp-2">${esc(job.name)}</strong>${badge(running ? "运行中" : "需关注", running ? "info" : "warning")}</span>
      ${showLast ? `<small>上次：${esc(Core.jobLastStatusLabel(job))}</small>` : ""}
      ${job.lastError ? `<small class="clamp-2">${esc(job.lastError)}</small>` : ""}</span></a>`;
  }

  function outcomeRow(item) {
    const failed = item.kind === "failed";
    return `<div class="card row-card outcome"><a class="row-main" href="${sessionHref(item.sessionId)}">${tile(failed ? "xCircle" : "checkCircle", failed ? "danger" : "success", 32)}
      <span class="grow"><span class="row-top"><strong>${esc(item.title)}</strong><time>${esc(relative(item.createdAt))}</time></span>
      ${item.sessionTitle ? `<small class="ellipsis">${esc(item.sessionTitle)}</small>` : ""}
      ${item.detail ? `<small class="clamp-3">${esc(item.detail)}</small>` : ""}</span></a>
      <button class="icon-btn subtle" data-act="dismiss-outcome" data-id="${esc(item.id)}" aria-label="清除这条结果" title="清除">${icon("x")}</button></div>`;
  }

  function approvalCard(approval, { context, createdAt, busy, showsPaths, origin: from }) {
    const actions = Core.approvalActions(approval);
    const menuId = `approval:${from}:${approval.id}`;
    const open = state.menu === menuId;
    const data = `data-approval="${esc(approval.id)}" data-origin="${from}"`;
    const paths = showsPaths ? Core.approvalPaths(approval.command) : null;
    return `<div class="card approval-card">
      <div class="approval-head">${tile("hand", "warning", 32)}<span class="grow"><strong>需要你的审批</strong>${context ? `<small class="ellipsis">${esc(context)}</small>` : ""}</span>${createdAt ? `<time>${esc(relative(createdAt))}</time>` : ""}</div>
      ${approval.description ? `<p class="approval-text">${esc(approval.description)}</p>` : ""}
      ${approval.command ? `<div class="command"><small>完整命令</small><code>${esc(approval.command)}</code></div>` : ""}
      ${paths ? (paths.length ? `<div class="paths"><small>命令里的路径</small>${paths.map((path) => `<code>${esc(path)}</code>`).join("")}</div>` : `<small class="muted">服务端没有返回文件差异</small>`) : ""}
      <div class="approval-actions">
        ${actions.once ? `<button class="pill filled tone-accent" data-act="approve" data-choice="once" ${data} ${busy ? "disabled" : ""}>允许本次</button>` : ""}
        <button class="pill tone-danger" data-act="approve" data-choice="deny" ${data} ${busy ? "disabled" : ""}>拒绝</button>
        ${actions.session || actions.always ? `<div class="menu-wrap"><button class="pill tone-neutral" data-act="menu" data-menu="${esc(menuId)}" aria-haspopup="menu" aria-expanded="${open}" ${busy ? "disabled" : ""}>更多授权${icon("chevronDown")}</button>
          ${open ? `<div class="menu" role="menu">${actions.session ? `<button role="menuitem" data-act="approve-elevated" data-choice="session" ${data}>${icon("clock")}本次会话允许</button>` : ""}${actions.always ? `<button role="menuitem" data-act="approve-elevated" data-choice="always" ${data}>${icon("check")}始终允许</button>` : ""}</div>` : ""}</div>` : ""}
        ${busy ? spinner() : ""}
      </div>
    </div>`;
  }

  // ---- sessions

  function sessionsSplit(route) {
    const conv = route.name === "session" ? currentConversation() : null;
    const detail = conv ? chatView(conv)
      : `<section class="pane pane-empty">${emptyState("chats", "选择一段服务端会话", "消息由 Hermes 服务器保存，其他客户端也能继续。")}</section>`;
    return `<div class="split ${conv ? "has-detail" : "no-detail"}"><section class="pane pane-list" data-scroll="pane:sessions">${sessionsList(conv)}</section>${detail}</div>`;
  }

  function sessionsList(activeConv) {
    const r = state.remote;
    const visible = Core.filterSessions(r.sessions, r.query, r.pinnedOnly);
    const supportsPin = r.sessions.some((session) => session.pinned != null);
    let body = "";
    if (r.error) body += loadBanner(r.error, r.sessions.length > 0, "reload-sessions", sessionActionsDisabled());
    if (r.loading && !r.sessions.length) body += `<div class="card muted-card">${spinner()}正在读取服务端会话…</div>`;
    else if (!visible.length && !r.error) {
      body += r.sessions.length ? emptyState("search", "没有匹配的会话", "试试其他关键词、切换置顶筛选，或继续加载更多记录。")
        : emptyState("server", "没有服务端会话", "新建一段会话，消息会保存在 Hermes 服务器上。");
    }
    if (r.sessions.length) {
      body += `<div class="list-head"><span>已加载 ${r.sessions.length} 段 · 置顶优先</span>${supportsPin ? `<button class="chip small${r.pinnedOnly ? " selected" : ""}" data-act="toggle-pinned-only" aria-pressed="${r.pinnedOnly}">${icon("pin")}${r.pinnedOnly ? "仅置顶" : "全部"}</button>` : ""}</div>`;
    }
    body += `<div class="stack">${visible.map((session) => sessionRow(session, activeConv)).join("")}</div>`;
    if (r.hasMore) body += `<button class="btn block subtle" data-act="more-sessions" ${sessionActionsDisabled() ? "disabled" : ""}>${r.loadingMore ? spinner() : ""}加载更多会话</button>`;
    body += updatedRow(r.updatedAt);
    return `<div class="page list-page">
      ${pageHead("对话", `<button class="icon-btn" data-act="reload-sessions" aria-label="刷新会话" ${sessionActionsDisabled() ? "disabled" : ""}>${r.loading ? spinner() : icon("refresh")}</button><button class="icon-btn accent" data-act="new-session" aria-label="新建服务端会话" ${sessionActionsDisabled() ? "disabled" : ""}>${icon("plus")}</button>`)}
      <label class="search">${icon("search")}<input id="sessionQuery" type="search" value="${esc(r.query)}" placeholder="搜索标题、摘要、来源或 ID" aria-label="搜索已加载的服务端会话" autocomplete="off"></label>
      ${body}
    </div>`;
  }

  function sessionRow(session, activeConv) {
    const conv = findConversation(session.id);
    const status = conv && conv.approvals.length ? badge("待审批", "warning") : conv && conv.isSending ? badge("运行中", "info") : "";
    const busy = state.remote.busyId === session.id;
    const active = activeConv && (activeConv.activeSessionId === session.id || activeConv.session.id === session.id);
    return `<div class="card row-card session-row${active ? " active" : ""}">
      <a class="row-main" href="${sessionHref(session.id)}"${active ? ' aria-current="page"' : ""}>
        <span class="row-top">${session.pinned ? `<span class="pin-mark" title="已置顶">${icon("pin")}</span>` : ""}<strong class="ellipsis">${esc(Core.sessionTitle(session))}</strong>${status}${busy ? spinner("small") : ""}<time>${session.lastActive ? esc(relative(session.lastActive * 1000)) : ""}</time></span>
        ${session.preview ? `<small class="clamp-2 preview">${esc(session.preview)}</small>` : ""}
        <span class="row-meta">${origin()}<span>${esc(session.source || "Hermes")}</span>${session.messageCount != null ? `<span>· ${session.messageCount} 条消息</span>` : ""}</span>
      </a>
      ${session.pinned != null ? `<button class="icon-btn subtle pin-btn${session.pinned ? " on" : ""}" data-act="toggle-pin" data-id="${esc(session.id)}" aria-label="${session.pinned ? "取消置顶" : "置顶"}" title="${session.pinned ? "取消置顶" : "置顶"}" ${sessionActionsDisabled() ? "disabled" : ""}>${icon("pin")}</button>` : ""}
    </div>`;
  }

  function chatView(conv) {
    const visible = conv.visibleMessages;
    const menuOpen = state.menu === "chat";
    const busy = !conv.canSend;
    const session = conv.session;
    let timeline = "";
    if (conv.isLoading && !conv.loaded) timeline += `<div class="timeline-note">${spinner()}正在读取消息…</div>`;
    if (conv.loadError && !conv.loaded) timeline += loadBanner(conv.loadError, false, "conv-reload", conv.isLoading);
    if (conv.hasOlder) timeline += `<button class="pill tone-neutral older" data-act="older" ${busy ? "disabled" : ""}>${conv.isLoadingOlder ? spinner() : icon("arrowUp")}加载更早的消息</button>`;
    if (conv.loaded && !visible.length && !conv.isSending && !conv.transientInput) {
      timeline += emptyState("server", "开始这段会话", "发送消息后，Hermes 会在服务端保存对话，其他客户端也能继续。");
    }
    timeline += visible.map((message) => messageRow(message, conv)).join("");
    if (conv.transientInput != null || conv.transientImage) {
      timeline += `<div class="msg msg-user pending">${conv.transientImage ? `<img class="msg-image" src="${esc(conv.transientImage)}" alt="已发送的图片">` : ""}${conv.transientInput ? `<div class="bubble">${esc(conv.transientInput)}</div>` : ""}</div>`;
    }
    if (conv.isSending || conv.streamedReply) {
      timeline += `<div class="msg msg-assistant live" data-live="${conv.key}"${conv.streamedReply ? "" : " hidden"}><div class="msg-head">${mark(22)}<strong>Hermes</strong></div><div class="md">${Core.renderMarkdown(conv.streamedReply)}</div></div>`;
    }
    timeline += conv.approvals.map((approval) => approvalCard(approval, { busy: conv.approvalBusy || conv.isStopping, showsPaths: true, origin: "session" })).join("");
    timeline += runStatus(conv);
    return `<section class="pane chat" data-conv="${conv.key}">
      <header class="chat-head">
        <a class="icon-btn back" href="#/sessions" aria-label="返回会话列表">${icon("chevronLeft")}</a>
        <div class="chat-title"><h1 class="ellipsis">${esc(Core.sessionTitle(session))}</h1><small class="ellipsis">${esc(session.source || "Hermes")} · 服务端会话${session.messageCount != null ? ` · ${session.messageCount} 条消息` : ""}</small></div>
        <button class="icon-btn" data-act="conv-search" aria-label="查找已加载消息" aria-pressed="${conv.searchOpen}" ${visible.length ? "" : "disabled"}>${icon("search")}</button>
        <button class="icon-btn" data-act="conv-reload" aria-label="刷新消息" ${busy ? "disabled" : ""}>${conv.isLoading ? spinner() : icon("refresh")}</button>
        <div class="menu-wrap"><button class="icon-btn" data-act="menu" data-menu="chat" aria-label="服务端会话操作" aria-haspopup="menu" aria-expanded="${menuOpen}">${icon("more")}</button>
          ${menuOpen ? `<div class="menu right" role="menu">
            <button role="menuitem" data-act="conv-rename" ${busy ? "disabled" : ""}>${icon("pencil")}重命名</button>
            <button role="menuitem" data-act="conv-copy" ${visible.length ? "" : "disabled"}>${icon("copy")}复制已加载的记录</button>
            <button role="menuitem" data-act="conv-download" ${visible.length ? "" : "disabled"}>${icon("download")}下载记录（Markdown）</button>
            <button role="menuitem" class="danger" data-act="conv-delete" ${busy ? "disabled" : ""}>${icon("trash")}删除服务端会话</button>
          </div>` : ""}</div>
      </header>
      ${conv.searchOpen ? searchPanel(conv, visible) : ""}
      <div class="timeline" data-scroll="timeline:${conv.key}"><div class="timeline-inner">${timeline}</div></div>
      <button class="pill tone-neutral latest${conv.follow ? "" : " show"}" data-act="latest" aria-label="返回最新">${icon("arrowDown")}返回最新</button>
      ${composer(conv)}
    </section>`;
  }

  function searchPanel(conv, visible) {
    const entries = visible.map((message) => ({ id: message.id, label: Core.roleLabel(message), text: message.content }));
    const hits = Core.messageSearchHits(entries, conv.searchQuery).slice(0, 50);
    let list = "";
    if (!conv.searchQuery.trim()) list = `<p class="search-note">输入关键词，点按结果回到对应消息。</p>`;
    else if (!hits.length) list = `<p class="search-note">没有找到“${esc(conv.searchQuery.trim())}”。</p>`;
    else list = hits.map((hit) => `<button class="hit" data-act="jump" data-id="${esc(hit.entry.id)}"><small>${esc(hit.entry.label)}</small><span>${esc(hit.before)}<mark>${esc(hit.match)}</mark>${esc(hit.after)}</span></button>`).join("");
    return `<div class="search-panel">
      <label class="search">${icon("search")}<input id="messageSearch" type="search" value="${esc(conv.searchQuery)}" placeholder="关键词" aria-label="查找已加载消息" autocomplete="off"></label>
      <small class="muted">此服务端会话已加载的消息 · ${visible.length} 条；更早记录需先加载</small>
      <div class="hits">${list}</div>
    </div>`;
  }

  function messageRow(message, conv) {
    const kind = Core.rowKind(message.role);
    const highlighted = conv.highlight === message.id;
    const failed = message.displayKind === "failed_turn";
    const badges = (highlighted ? badge("定位消息", "accent", "search") : "") + (failed ? badge("本轮未执行", "warning", "alert") : "");
    const id = esc(message.id);
    const copy = `<button class="icon-btn tiny msg-copy" data-act="copy-message" data-id="${id}" aria-label="复制消息" title="复制消息">${icon("copy")}</button>`;
    const cls = `msg msg-${kind}${highlighted ? " highlighted" : ""}`;
    if (kind === "user") {
      return `<div class="${cls}" data-mid="${id}">${badges ? `<div class="msg-badges">${badges}</div>` : ""}<div class="bubble">${esc(message.content)}</div>${copy}</div>`;
    }
    if (kind === "assistant") {
      return `<div class="${cls}" data-mid="${id}"><div class="msg-head">${mark(22)}<strong>Hermes</strong>${badges}${copy}</div><div class="md">${markdown(message.content)}</div></div>`;
    }
    const long = message.content.length > 1600 || message.content.split("\n").length > 24;
    const expanded = conv.expanded.has(message.id);
    return `<div class="${cls}" data-mid="${id}"><div class="msg-head small">${icon(kind === "tool" ? "wrench" : "gear")}<span class="ellipsis">${esc(Core.roleLabel(message))}</span>${badges}${copy}</div>
      <div class="compact-body${long && !expanded ? " collapsed" : ""}">${esc(message.content)}</div>
      ${long ? `<button class="link-btn small" data-act="expand" data-id="${id}">${expanded ? "收起" : "展开全部"}</button>` : ""}</div>`;
  }

  function runStatus(conv) {
    if (!conv.isSending && !conv.progress) return "";
    return `<div class="run-status" role="status" aria-live="polite">${conv.isSending ? spinner() : dot("accent")}<span class="run-text" data-progress="${conv.key}">${esc(conv.progress || "正在运行…")}</span>
      ${conv.isSending ? `<button class="pill tone-danger" data-act="stop" ${conv.isStopping ? "disabled" : ""}>${icon("stop")}${conv.isStopping ? "正在停止" : "停止"}</button>` : ""}</div>`;
  }

  function composer(conv) {
    const disabledPhoto = !conv.canSend || conv.loadingPhoto;
    return `<footer class="composer-wrap">
      ${conv.error ? `<div class="inline-alert" role="alert">${icon("alert")}<span>${esc(conv.error)}</span><button class="icon-btn tiny" data-act="dismiss-conv-error" aria-label="关闭提示">${icon("x")}</button></div>` : ""}
      ${conv.isSending || conv.approvals.length ? `<div class="revision"><p>${icon("undo")}想改方向？先停止，改口内容会放进输入框，需你再发送。不会插入当前这一轮。</p>
        <div class="revision-row"><textarea id="revision" rows="1" data-grow placeholder="改口内容" aria-label="改口内容">${esc(conv.revision)}</textarea>
        <button class="pill tone-danger" data-act="stop-revise" ${conv.isStopping || !conv.revision.trim() ? "disabled" : ""}>停止并放进输入框</button></div></div>` : ""}
      <div class="composer">
        ${conv.pendingImage ? `<div class="thumb"><img src="${esc(conv.pendingImage)}" alt="待发送图片"><button class="thumb-remove" data-act="remove-image" aria-label="移除图片">${icon("x")}</button></div>` : ""}
        <textarea id="draft" rows="1" data-grow placeholder="继续这段服务端会话…" aria-label="服务端会话消息">${esc(conv.draft)}</textarea>
        <div class="composer-bar">
          <label class="icon-btn${disabledPhoto ? " disabled" : ""}" title="添加图片" aria-label="添加图片"><input type="file" accept="image/*" data-file="image" hidden ${disabledPhoto ? "disabled" : ""}>${conv.loadingPhoto ? spinner() : icon("image")}</label>
          <span class="grow hint">${IS_MAC ? "⌘" : "Ctrl"}+Enter 发送</span>
          ${origin()}
          ${conv.isSending ? `<button class="round-btn danger" data-act="stop" aria-label="停止" ${conv.isStopping ? "disabled" : ""}>${icon("stop")}</button>`
            : `<button class="round-btn" data-act="send" aria-label="发送到服务端会话" ${canSendMessage(conv) ? "" : "disabled"}>${icon("arrowUp")}</button>`}
        </div>
      </div>
    </footer>`;
  }

  // ---- jobs

  function jobsView() {
    const j = state.jobs;
    const visible = Core.filterJobs(j.list, j.query, j.filter);
    const overview = Core.jobOverview(j.list);
    const tileButton = (title, count, filter, tone, iconName) => `<button class="card overview${j.filter === filter ? ` selected tone-${tone}` : ""}" data-act="job-filter" data-filter="${filter === j.filter ? "all" : filter}" aria-pressed="${j.filter === filter}" aria-label="${title}，${count} 个任务">
      <span class="tone-text-${tone}">${icon(iconName)}</span><strong>${count}</strong><small>${title}</small></button>`;
    let list = "";
    if (j.error) list += loadBanner(j.error, j.list.length > 0, "reload-jobs", jobActionsDisabled());
    if (j.loading && !j.list.length) list += `<div class="card muted-card">${spinner()}正在读取定时任务…</div>`;
    else if (!visible.length && !j.error) {
      list += j.list.length ? emptyState("search", "没有匹配的任务", "试试其他关键词或状态筛选。") : emptyState("jobs", "没有定时任务", "点击右上角 + 创建一个任务。");
    }
    if (visible.length) list += `<div class="list-head"><span>${visible.length} / ${j.list.length} 个任务</span><span>${j.refreshSeconds ? `前台${Core.refreshTitle(j.refreshSeconds)}刷新` : "手动刷新"}</span></div>`;
    list += `<div class="stack">${visible.map(jobRow).join("")}</div>`;
    list += updatedRow(j.updatedAt);
    return `<div class="page">
      ${pageHead("定时任务", `<label class="select-pill" title="任务自动刷新">${icon(j.refreshSeconds ? "clock" : "refresh")}<select id="refreshInterval" aria-label="任务自动刷新">${Core.REFRESH_INTERVALS.map((seconds) => `<option value="${seconds}" ${seconds === j.refreshSeconds ? "selected" : ""}>${Core.refreshTitle(seconds)}</option>`).join("")}</select></label>
        <button class="icon-btn" data-act="reload-jobs" aria-label="刷新任务" ${jobActionsDisabled() ? "disabled" : ""}>${j.loading ? spinner() : icon("refresh")}</button>
        <button class="icon-btn accent" data-act="new-job" aria-label="新建定时任务" ${jobActionsDisabled() ? "disabled" : ""}>${icon("plus")}</button>`)}
      <div class="overview-row">${tileButton("运行中", overview.running, "running", "info", "play")}${tileButton("需关注", overview.attention, "attention", "warning", "alert")}${tileButton("已暂停", overview.paused, "paused", "neutral", "pause")}</div>
      <div class="chips" role="group" aria-label="按状态筛选">${Core.JOB_FILTERS.map((filter) => `<button class="chip${j.filter === filter.id ? " selected" : ""}" data-act="job-filter" data-filter="${filter.id}" aria-pressed="${j.filter === filter.id}">${filter.title}</button>`).join("")}</div>
      <label class="search">${icon("search")}<input id="jobQuery" type="search" value="${esc(j.query)}" placeholder="搜索任务名称、说明、日程或 ID" aria-label="搜索任务" autocomplete="off"></label>
      ${j.notice ? `<div class="card notice">${icon("info")}<span class="grow">${esc(j.notice)}</span><button class="icon-btn tiny" data-act="dismiss-notice" aria-label="关闭运行提示">${icon("x")}</button></div>` : ""}
      ${list}
      <p class="footnote">只在任务列表可见且页面在前台时自动读取；失败后自动放慢。日程按 Hermes 服务端时区执行。</p>
    </div>`;
  }

  function jobBadge(job) {
    return badge(Core.jobStatusLabel(job), Core.jobStatusTone(job));
  }

  function jobRow(job) {
    const attention = Core.jobNeedsAttention(job);
    return `<a class="card job-row" href="${jobHref(job.id)}">
      <span class="row-top"><strong class="clamp-2">${esc(job.name)}</strong>${jobBadge(job)}</span>
      <small class="meta-line">${icon("calendar")}${esc(job.scheduleDisplay || "未设置日程")}</small>
      ${job.prompt ? `<span class="clamp-2 job-prompt">${esc(job.prompt)}</span>` : ""}
      <small class="meta-line">${job.nextRunAt != null ? `<span>${icon("clock")}下次 ${esc(Core.displayRemoteTimestamp(job.nextRunAt))}</span>` : ""}
      ${attention ? `<span class="tone-text-warning">${icon("alert")}最近运行需要关注</span>` : job.lastStatus != null ? `<span>上次：${esc(Core.jobLastStatusLabel(job))}</span>` : ""}</small>
    </a>`;
  }

  function jobView(id) {
    const j = state.jobs;
    const job = j.list.find((item) => item.id === id);
    const busy = jobActionsDisabled();
    const refreshing = j.refreshingId === id || j.busyId === id;
    const head = pageHead("任务详情", `<button class="icon-btn" data-act="refresh-job" data-id="${esc(id)}" aria-label="刷新任务详情" ${busy ? "disabled" : ""}>${refreshing ? spinner() : icon("refresh")}</button>`, "#/jobs");
    if (!job) {
      return `<div class="page">${head}${j.detailError ? loadBanner(j.detailError, false, "refresh-job", busy) : `<div class="card muted-card">${spinner()}正在读取任务…</div>`}</div>`;
    }
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "本地";
    const row = (label, value) => `<div class="kv"><span>${label}</span><span>${esc(value)}</span></div>`;
    const canToggle = job.state !== "completed" && job.state !== "error";
    return `<div class="page">
      ${head}
      ${j.detailError ? loadBanner(j.detailError, true, "refresh-job", busy) : ""}
      ${j.notice ? `<div class="card notice">${icon("info")}<span class="grow">${esc(j.notice)}</span><button class="icon-btn tiny" data-act="dismiss-notice" aria-label="关闭运行提示">${icon("x")}</button></div>` : ""}
      <h3 class="group-title">任务</h3>
      <div class="group">
        <div class="group-row"><strong class="grow selectable">${esc(job.name)}</strong>${jobBadge(job)}</div>
        <div class="group-row prose selectable">${esc(job.prompt ? job.prompt : "未提供任务说明")}</div>
        <div class="kv small"><span>任务 ID</span><code class="selectable">${esc(job.id)}</code></div>
      </div>
      <h3 class="group-title">运行时间与结果</h3>
      <div class="group">${row("日程", job.scheduleDisplay ?? "未设置")}${row("下次运行", Core.displayRemoteTimestamp(job.nextRunAt))}${row("上次运行", Core.displayRemoteTimestamp(job.lastRunAt))}${row("上次结果", Core.jobLastStatusLabel(job))}</div>
      <p class="footnote">带时区的时间按浏览器时区（${esc(zone)}）显示；未提供时区的时间保留原文。日程仍按服务端时区执行。</p>
      ${job.lastError ? `<h3 class="group-title">最近错误</h3><div class="group"><div class="group-row prose tone-text-warning selectable">${esc(job.lastError)}</div></div>` : ""}
      <h3 class="group-title">管理</h3>
      <div class="group actions-group">
        <button class="group-row" data-act="edit-job" ${busy ? "disabled" : ""}>${icon("pencil")}编辑任务</button>
        <button class="group-row" data-act="copy-job" ${busy ? "disabled" : ""}>${icon("copy")}复制为新任务</button>
        ${canToggle ? `<button class="group-row" data-act="toggle-job" ${busy ? "disabled" : ""}>${icon(Core.jobIsPaused(job) ? "play" : "pause")}${Core.jobIsPaused(job) ? "恢复任务" : "暂停任务"}</button>` : ""}
        <button class="group-row" data-act="run-job" ${busy ? "disabled" : ""}>${icon("bolt")}立即运行</button>
        <button class="group-row danger" data-act="delete-job" ${busy ? "disabled" : ""}>${icon("trash")}删除任务</button>
      </div>
      <p class="footnote">操作会直接更新服务端任务。手动运行提交后，请刷新查看运行结果。</p>
    </div>`;
  }

  // ---- settings

  function settingsView(setup) {
    const conn = state.conn;
    const status = statusInfo();
    const customSaved = Boolean(conn.url && conn.key);
    const sending = anySending();
    const rows = [];
    if (workbenchURL) {
      const active = conn.mode === "default";
      rows.push(`<div class="group-row conn-row"><button class="conn-pick" data-act="use-default" aria-pressed="${active}" ${sending ? "disabled" : ""}>
        <span class="radio${active ? " on" : ""}">${active ? icon("check") : ""}</span><span class="grow"><strong>默认连接（Tailscale）</strong><small class="ellipsis">${esc(Core.hostOf(workbenchURL))}</small>${active ? `<small class="accent-text">当前连接 · 密钥由工作台中继保管</small>` : ""}</span></button></div>`);
    }
    if (customSaved) {
      const active = conn.mode === "custom";
      rows.push(`<div class="group-row conn-row"><button class="conn-pick" data-act="use-custom" aria-pressed="${active}" ${sending ? "disabled" : ""}>
        <span class="radio${active ? " on" : ""}">${active ? icon("check") : ""}</span><span class="grow"><strong>${esc(conn.name || Core.hostOf(conn.url))}</strong><small class="ellipsis">${esc(conn.url)}</small>${active ? `<small class="accent-text">当前连接 · 自定义</small>` : ""}</span></button>
        <button class="icon-btn subtle" data-act="edit-connection" aria-label="编辑自定义连接" ${sending ? "disabled" : ""}>${icon("pencil")}</button></div>`);
    }
    const form = state.form || (setup && !customSaved ? (state.form = { name: "", url: "", key: "", busy: false, feedback: "", ok: false, models: [] }) : null);
    const hint = localProxy() ? "本机打开。密钥只存在当前浏览器，经本地代理转发，可连接局域网 HTTP。"
      : "从统一入口打开。服务必须是 HTTPS，并允许来源 " + HUB_ORIGIN + "。局域网 HTTP 请用 python3 web/serve.py。";
    return `<div class="page">
      ${pageHead(setup ? "连接 Hermes" : "设置")}
      ${setup ? `<div class="card intro">${mark(44)}<div><strong>连接你自己的 Hermes</strong><p>填写服务地址和 API 密钥，或用另一台设备上的配对码添加。网页版只读写服务器上的会话和定时任务。</p></div></div>`
        : `<div class="card profile">${mark(48)}<span class="grow"><strong>${esc(connectionName())}</strong><small class="ellipsis">${esc(conn.mode === "default" ? workbenchURL : conn.url)}</small><small>${dot(status.tone)}${status.title}${state.models.length ? ` · ${state.models.length} 个模型名称` : ""}</small></span></div>`}
      <h3 class="group-title">连接</h3>
      <div class="group">
        ${rows.join("")}
        <button class="group-row" data-act="edit-connection" ${sending ? "disabled" : ""}>${tile("plus", "accent", 30)}<span class="grow">${customSaved ? "编辑自定义连接" : "添加自定义连接"}<small>手动填写服务地址和 API 密钥</small></span></button>
        <button class="group-row" data-act="pair-scan" ${sending ? "disabled" : ""}>${tile("scan", "info", 30)}<span class="grow">扫码添加连接<small>${scanSupported() ? "用相机或图片读取另一台设备的配对码" : "此浏览器不能扫码，可以粘贴配对码"}</small></span>${icon("chevronRight", "muted")}</button>
        <button class="group-row" data-act="pair-paste" ${sending ? "disabled" : ""}>${tile("paste", "info", 30)}<span class="grow">粘贴配对码<small>粘贴配对码文字或带 pair 参数的链接</small></span>${icon("chevronRight", "muted")}</button>
        ${setup ? "" : `<button class="group-row" data-act="pair-show">${tile("qr", "info", 30)}<span class="grow">显示配对码<small>让另一台设备扫码添加当前连接</small></span>${icon("chevronRight", "muted")}</button>`}
        ${customSaved && !setup ? `<button class="group-row danger" data-act="remove-custom" ${sending ? "disabled" : ""}>${tile("trash", "danger", 30)}<span class="grow">移除自定义连接<small>从这个浏览器删除地址和密钥</small></span></button>` : ""}
      </div>
      ${sending ? `<p class="footnote">回复进行中，停止或完成后即可修改连接。</p>` : ""}
      ${form ? connectionForm(form) : ""}
      <p class="footnote">${esc(conn.mode === "default" && !setup ? "使用已授权的 Tailscale 账号连接。" : hint)} 网页只保存一个自定义连接；API 密钥保存在这个浏览器的本地存储中，保存新连接会替换旧连接。</p>
      ${setup ? "" : `<h3 class="group-title">显示</h3>
      <div class="group"><label class="group-row">${tile("contrast", "neutral", 30)}<span class="grow">外观</span>
        <select id="appearance" aria-label="外观">${[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]].map(([value, title]) => `<option value="${value}" ${state.appearance === value ? "selected" : ""}>${title}</option>`).join("")}</select></label></div>
      <p class="footnote">外观设置只保存在这个浏览器。</p>`}
      <h3 class="group-title">帮助</h3>
      <div class="group"><details class="group-row help"><summary>${tile("laptop", "warning", 30)}<span class="grow">在 Mac 上启用</span>${icon("chevronDown", "muted")}</summary>
        <p>在 ~/.hermes/.env 中设置 API_SERVER_ENABLED=true 和 API_SERVER_KEY，然后运行 hermes gateway。默认服务端口是 8642。远程连接使用 HTTPS；从网页直接连接时，服务需允许本页来源（CORS）。局域网 HTTP 地址请在本机运行 python3 web/serve.py 后使用。</p></details></div>
      <h3 class="group-title">关于 Hermes Web</h3>
      <div class="group"><div class="kv"><span>版本</span><span>${esc(Core.VERSION)}</span></div></div>
      <p class="footnote">网页版处理服务端内容：会话、审批、运行状态和定时任务由你连接的服务器管理。iOS 的本机对话、项目、资料、消息库、本机草稿和 JSON 备份不在网页中。</p>
    </div>`;
  }

  function connectionForm(form) {
    return `<form class="card form" data-form="connection">
      <h3>${state.conn.url && state.conn.key ? "编辑自定义连接" : "添加自定义连接"}</h3>
      <label><span>连接名称</span><input id="formName" data-bind="form.name" value="${esc(form.name)}" placeholder="例如：家中的 Mac" autocomplete="off"></label>
      <label><span>服务地址</span><input id="formURL" data-bind="form.url" value="${esc(form.url)}" placeholder="https://hermes.example.com/v1" inputmode="url" autocomplete="off" spellcheck="false"></label>
      <label><span>API 密钥</span><input id="formKey" data-bind="form.key" type="password" value="${esc(form.key)}" placeholder="API_SERVER_KEY" autocomplete="off" spellcheck="false"></label>
      <p class="footnote">服务根路径、以 /v1 结尾的地址和 Profile 路径都可以，例如 https://example.com/p/work/v1。</p>
      ${form.feedback ? `<p class="feedback ${form.ok ? "ok" : "bad"}" role="status">${icon(form.ok ? "checkCircle" : "alert")}<span>${esc(form.feedback)}</span></p>` : ""}
      ${form.models.length ? `<div class="model-list">${form.models.slice(0, 12).map((name) => `<span class="chip small">${esc(name)}</span>`).join("")}</div>` : ""}
      <div class="form-actions">
        ${connectionValid() ? `<button type="button" class="btn subtle" data-act="cancel-form">取消</button>` : ""}
        <button type="button" class="btn subtle" data-act="test-form" ${form.busy ? "disabled" : ""}>${form.busy ? spinner() : ""}测试连接</button>
        <button type="submit" class="btn primary" ${form.busy ? "disabled" : ""}>保存</button>
      </div>
    </form>`;
  }

  // ---- dialogs

  function modalView() {
    const modal = state.modal;
    if (!modal) return "";
    let body = "";
    switch (modal.kind) {
      case "alert":
        body = `<h2>${esc(modal.title)}</h2><p class="modal-text">${esc(modal.message)}</p>
          <div class="modal-actions"><button class="btn primary" data-act="modal-close" autofocus>知道了</button></div>`;
        break;
      case "confirm":
        body = `<h2>${esc(modal.title)}</h2>${modal.message ? `<p class="modal-text">${esc(modal.message)}</p>` : ""}${modal.error ? `<p class="feedback bad">${icon("alert")}<span>${esc(modal.error)}</span></p>` : ""}
          <div class="modal-actions"><button class="btn subtle" data-act="modal-close" ${modal.busy ? "disabled" : ""}>取消</button>
          <button class="btn ${modal.danger ? "danger" : "primary"}" data-act="modal-confirm" ${modal.busy ? "disabled" : ""}>${modal.busy ? spinner() : ""}${esc(modal.confirmLabel)}</button></div>`;
        break;
      case "prompt":
        body = `<form data-form="prompt"><h2>${esc(modal.title)}</h2>${modal.message ? `<p class="modal-text">${esc(modal.message)}</p>` : ""}
          <label class="field"><span>${esc(modal.label)}</span><input id="modalValue" data-bind="modal.value" value="${esc(modal.value)}" autocomplete="off" autofocus></label>
          ${modal.error ? `<p class="feedback bad">${icon("alert")}<span>${esc(modal.error)}</span></p>` : ""}
          <div class="modal-actions"><button type="button" class="btn subtle" data-act="modal-close" ${modal.busy ? "disabled" : ""}>取消</button>
          <button type="submit" class="btn primary" ${modal.busy || (modal.required && !modal.value.trim()) ? "disabled" : ""}>${modal.busy ? spinner() : ""}${esc(modal.confirmLabel)}</button></div></form>`;
        break;
      case "jobEditor":
        body = jobEditorView(modal);
        break;
      case "pairPaste":
        body = `<form data-form="pair-paste"><h2>粘贴配对码</h2>
          ${modal.note ? `<p class="modal-text">${esc(modal.note)}</p>` : `<p class="modal-text">粘贴另一台设备配对码中的文字（例如用系统相机扫码后复制的内容），或带 pair 参数的链接。</p>`}
          <label class="field"><span>配对码内容</span><textarea id="pairText" data-bind="modal.text" rows="4" placeholder='{"v":1,"name":"…","url":"…","key":"…"}' spellcheck="false" autofocus>${esc(modal.text)}</textarea></label>
          ${modal.error ? `<p class="feedback bad">${icon("alert")}<span>${esc(modal.error)}</span></p>` : ""}
          <p class="footnote warning-text">配对码包含 API 密钥，只使用来自你自己设备的配对码。</p>
          <div class="modal-actions">${scanSupported() ? `<label class="btn subtle">从图片识别<input type="file" accept="image/*" data-file="pair-image" hidden></label>` : ""}
          <span class="grow"></span><button type="button" class="btn subtle" data-act="modal-close">取消</button>
          <button type="submit" class="btn primary" ${modal.text.trim() ? "" : "disabled"}>识别</button></div></form>`;
        break;
      case "pairConfirm": {
        const replace = state.conn.url && state.conn.key;
        body = `<form data-form="pair-confirm"><h2>添加扫码连接</h2>
          <p class="modal-text">确认名称和地址后保存。保存后会切换到这个连接。</p>
          <label class="field"><span>连接名称</span><input id="pairName" data-bind="modal.name" value="${esc(modal.name)}" autocomplete="off" autofocus></label>
          <div class="kv"><span>服务地址</span><span class="selectable">${esc(modal.payload.url)}</span></div>
          <div class="kv"><span>API 密钥</span><span>已包含（${Core.charCount(modal.payload.key)} 个字符）</span></div>
          ${replace ? `<p class="footnote warning-text">网页只保存一个自定义连接，会替换“${esc(state.conn.name || Core.hostOf(state.conn.url))}”。</p>` : ""}
          ${modal.error ? `<p class="feedback bad">${icon("alert")}<span>${esc(modal.error)}</span></p>` : ""}
          <div class="modal-actions"><button type="button" class="btn subtle" data-act="modal-close">取消</button>
          <button type="submit" class="btn primary" ${modal.error && !modal.name ? "disabled" : ""}>保存并切换</button></div></form>`;
        break;
      }
      case "pairCode":
        body = pairCodeView();
        break;
      default: break;
    }
    return `<div class="modal-backdrop" data-act="modal-backdrop"><div class="modal${modal.kind === "jobEditor" ? " wide" : ""}" role="dialog" aria-modal="true">${body}</div></div>`;
  }

  function jobEditorView(modal) {
    const { job, copying, values, saving } = modal;
    const title = copying ? "复制定时任务" : job ? "编辑定时任务" : "新建定时任务";
    const note = copying ? "复制会创建一项独立的新任务，请检查说明与日程后创建。一次性任务必须重新填写时间；运行结果、错误和投递设置不会复制。"
      : job ? "保存后会更新服务端任务；修改日程会重新计算下次运行时间。" : "任务由 Hermes 服务端调度。";
    const canSave = Core.jobEditorCanSave(values, job, copying) && !saving;
    return `<form data-form="job-editor"><h2>${title}</h2>
      <label class="field"><span>名称 <small>${Core.charCount(values.name)} / 200</small></span><input id="jobName" data-bind="modal.values.name" value="${esc(values.name)}" placeholder="名称" autocomplete="off" autofocus ${saving ? "disabled" : ""}></label>
      <label class="field"><span>让 Hermes 做什么 <small>${Core.charCount(values.prompt)} / 5000</small></span><textarea id="jobPrompt" data-bind="modal.values.prompt" rows="5" placeholder="任务说明" ${saving ? "disabled" : ""}>${esc(values.prompt)}</textarea></label>
      <p class="footnote">名称最多 200 字，任务说明最多 5000 字。</p>
      <label class="field"><span>运行时间</span><input id="jobSchedule" data-bind="modal.values.schedule" value="${esc(values.schedule)}" placeholder="every 1h" autocomplete="off" spellcheck="false" ${saving ? "disabled" : ""}></label>
      <p class="footnote">示例：every 1h、every day at 9am、0 9 * * *、in 30m。具体时间按 Hermes 服务端时区计算。</p>
      <p class="footnote">${note}</p>
      ${modal.error ? `<p class="feedback bad">${icon("alert")}<span>保存失败：${esc(modal.error)}</span></p>` : ""}
      <div class="modal-actions"><button type="button" class="btn subtle" data-act="modal-close" ${saving ? "disabled" : ""}>取消</button>
      <button type="submit" class="btn primary" ${canSave ? "" : "disabled"}>${saving ? spinner() : ""}${job && !copying ? "保存" : "创建"}</button></div></form>`;
  }

  function pairCodeView() {
    const conn = state.conn;
    const close = `<div class="modal-actions"><button class="btn primary" data-act="modal-close">完成</button></div>`;
    const unavailable = (title, text) => `<h2>配对码</h2>${emptyState("qr", title, text)}${close}`;
    if (conn.mode === "default") return unavailable("默认连接无法出码", "默认连接的密钥保存在工作台中继，网页中没有密钥，无法生成配对码。");
    if (!conn.key.trim()) return unavailable("当前连接没有密钥，无法出码", connectionName());
    if (!conn.url.trim()) return unavailable("当前连接没有服务地址，无法出码", connectionName());
    if (Core.isLoopbackAddress(conn.url)) return unavailable("此地址只能在本机访问", "请先将连接地址改为另一台设备能访问的局域网地址或 HTTPS 地址，再生成配对码。");
    let svg;
    try { svg = Core.qrSvg(Core.encodePairing(connectionName(), conn.url, conn.key)); }
    catch (error) { return unavailable("无法生成配对码", error.message || "请检查当前连接后重试。"); }
    return `<h2>配对码</h2><div class="pair-code"><strong>${esc(connectionName())}</strong><small class="selectable">${esc(conn.url.trim())}</small>
      <div class="qr">${svg}</div><p class="warning-text">配对码含密钥，只给你自己的另一台设备扫。</p></div>${close}`;
  }

  // ------------------------------------------------------------------ render loop

  let renderQueued = false;
  let composing = false;
  let renderDeferred = false;
  const scrollMemory = new Map();

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    if (composing) { renderDeferred = true; return; }
    renderDeferred = false;
    const active = document.activeElement;
    const focus = active && active.id && app.contains(active) ? {
      id: active.id,
      start: typeof active.selectionStart === "number" ? active.selectionStart : null,
      end: typeof active.selectionEnd === "number" ? active.selectionEnd : null,
      top: active.scrollTop
    } : null;
    app.querySelectorAll("[data-scroll]").forEach((el) => scrollMemory.set(el.dataset.scroll, el.scrollTop));
    const oldTimeline = app.querySelector(".timeline");
    const previous = oldTimeline ? { key: oldTimeline.dataset.scroll, top: oldTimeline.scrollTop } : null;

    app.innerHTML = shell();

    app.querySelectorAll("[data-scroll]").forEach((el) => {
      if (el.classList.contains("timeline")) return;
      const top = scrollMemory.get(el.dataset.scroll);
      if (top != null) el.scrollTop = top;
    });
    restoreTimeline(previous);
    if (focus) {
      const el = document.getElementById(focus.id);
      if (el && !el.disabled) {
        el.focus({ preventScroll: true });
        if (focus.start != null && el.setSelectionRange) { try { el.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ } }
        el.scrollTop = focus.top;
      }
    }
    app.querySelectorAll("textarea[data-grow]").forEach(autoGrow);
    const approvals = inboxApprovals().length;
    document.title = approvals ? `(${approvals}) Hermes` : "Hermes";
    updatePoller();
  }

  function restoreTimeline(previous) {
    const conv = currentConversation();
    const el = app.querySelector(".timeline");
    if (!conv || !el) return;
    if (conv.jumpTo) {
      const target = el.querySelector(`[data-mid="${CSS.escape(conv.jumpTo)}"]`);
      conv.jumpTo = null;
      if (target) { el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 3; return; }
    }
    if (conv.anchor) {
      const target = el.querySelector(`[data-mid="${CSS.escape(conv.anchor.id)}"]`);
      if (target && !conv.isLoadingOlder) {
        el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - conv.anchor.offset;
        conv.anchor = null;
        return;
      }
      if (previous && previous.key === el.dataset.scroll) { el.scrollTop = previous.top; return; }
    }
    if (conv.follow || !previous || previous.key !== el.dataset.scroll) { el.scrollTop = el.scrollHeight; return; }
    el.scrollTop = previous.top;
  }

  function autoGrow(el) {
    el.style.height = "auto";
    const max = el.id === "draft" ? 180 : 96;
    el.style.height = Math.min(max, el.scrollHeight + 2) + "px";
    el.style.overflowY = el.scrollHeight + 2 > max ? "auto" : "hidden";
  }

  function stickToBottom(conv) {
    if (!conv.follow) return;
    const el = app.querySelector(".timeline");
    if (el) el.scrollTop = el.scrollHeight;
  }

  let livePending = null;
  function patchLive(conv) {
    if (livePending) return;
    livePending = conv;
    requestAnimationFrame(() => {
      livePending = null;
      const el = app.querySelector(`[data-live="${conv.key}"]`);
      if (!el) { if (state.currentKey === conv.key) scheduleRender(); return; }
      el.hidden = false;
      el.querySelector(".md").innerHTML = Core.renderMarkdown(conv.streamedReply);
      stickToBottom(conv);
    });
  }

  function patchProgress(conv) {
    const el = app.querySelector(`[data-progress="${conv.key}"]`);
    if (el) el.textContent = conv.progress;
    else if (state.currentKey === conv.key) scheduleRender();
  }

  // ------------------------------------------------------------------ events

  function setBinding(path, value) {
    const parts = path.split(".");
    let target = state;
    for (const part of parts.slice(0, -1)) {
      if (!target[part]) return;
      target = target[part];
    }
    target[parts[parts.length - 1]] = value;
  }

  const actions = {
    "new-session": newSessionDialog,
    "reload-sessions": reloadSessions,
    "more-sessions": loadMoreSessions,
    "toggle-pin": (el) => togglePin(el.dataset.id),
    "toggle-pinned-only": () => { state.remote.pinnedOnly = !state.remote.pinnedOnly; render(); },
    "reload-jobs": reloadJobs,
    "relay-try": (el) => tryRelay(el.dataset.retry),
    "dismiss-outcome": (el) => dismissOutcome(el.dataset.id),
    menu: (el) => { state.menu = state.menu === el.dataset.menu ? null : el.dataset.menu; render(); },
    approve: (el) => { state.menu = null; resolveApproval(el.dataset.approval, el.dataset.choice, el.dataset.origin); },
    "approve-elevated": (el) => confirmElevated(el.dataset.approval, el.dataset.choice, el.dataset.origin),
    send: () => withConv(sendMessage),
    stop: () => withConv(stopRun),
    "stop-revise": () => withConv(stopAndRevise),
    older: () => withConv(loadOlder),
    "conv-reload": () => withConv((conv) => { conv.error = ""; reloadConversation(conv); }),
    "conv-search": () => withConv((conv) => {
      conv.searchOpen = !conv.searchOpen;
      if (!conv.searchOpen) conv.highlight = null;
      render();
      if (conv.searchOpen) document.getElementById("messageSearch")?.focus();
    }),
    jump: (el) => withConv((conv) => { conv.highlight = el.dataset.id; conv.jumpTo = el.dataset.id; conv.follow = false; render(); }),
    latest: () => withConv((conv) => { conv.follow = true; conv.highlight = null; render(); }),
    "conv-rename": () => withConv(renameDialog),
    "conv-delete": () => withConv(deleteDialog),
    "conv-copy": () => withConv((conv) => { state.menu = null; copyText(Core.transcript(Core.sessionTitle(conv.session), conv.visibleMessages), "已复制已加载的记录"); }),
    "conv-download": () => withConv((conv) => {
      state.menu = null;
      const blob = new Blob([Core.transcript(Core.sessionTitle(conv.session), conv.visibleMessages)], { type: "text/markdown;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = (Core.sessionTitle(conv.session).replace(/[\\/:*?"<>|]+/g, " ").trim() || "hermes") + ".md";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      render();
    }),
    "copy-message": (el) => withConv((conv) => {
      const message = conv.messages.find((item) => item.id === el.dataset.id);
      if (message) copyText(message.content, "已复制消息");
    }),
    "copy-code": (el) => copyText(el.closest(".code-block").querySelector("code").textContent, "已复制代码"),
    expand: (el) => withConv((conv) => {
      if (conv.expanded.has(el.dataset.id)) conv.expanded.delete(el.dataset.id); else conv.expanded.add(el.dataset.id);
      render();
    }),
    "remove-image": () => withConv((conv) => { conv.pendingImage = null; render(); }),
    "dismiss-conv-error": () => withConv((conv) => { conv.error = ""; render(); }),
    "job-filter": (el) => { state.jobs.filter = el.dataset.filter; render(); },
    "new-job": () => jobEditor(null, false),
    "dismiss-notice": () => { state.jobs.notice = ""; render(); },
    "refresh-job": () => refreshJob(state.route.id),
    "edit-job": () => withJob((job) => jobEditor(job, false)),
    "copy-job": () => withJob((job) => jobEditor(job, true)),
    "toggle-job": () => withJob((job) => jobAction(job.id, "toggle")),
    "run-job": () => withJob((job) => openModal({
      kind: "confirm", title: `立即运行“${job.name}”？`, message: "此操作会在服务器上调度一次运行；已暂停的任务也会恢复。", confirmLabel: "立即运行",
      async onConfirm() { closeModal(); await jobAction(job.id, "run"); }
    })),
    "delete-job": () => withJob((job) => openModal({
      kind: "confirm", title: `删除“${job.name}”？`, message: "这会从服务器删除任务，并取消正在运行的任务。", confirmLabel: "删除任务", danger: true,
      async onConfirm() { closeModal(); if (await jobAction(job.id, "delete")) go("#/jobs"); }
    })),
    "use-default": () => useConnection("default"),
    "use-custom": () => useConnection("custom"),
    "edit-connection": editConnection,
    "cancel-form": () => { state.form = null; render(); },
    "test-form": testForm,
    "remove-custom": removeCustomDialog,
    "pair-scan": openScanner,
    "pair-paste": () => openModal({ kind: "pairPaste", text: "", error: "" }),
    "pair-show": () => openModal({ kind: "pairCode" }),
    "modal-close": () => { if (!state.modal || !state.modal.busy) closeModal(); },
    "modal-confirm": () => runModal(() => state.modal.onConfirm()),
    "modal-backdrop": (el, event) => { if (event.target === el && state.modal && !state.modal.busy && !state.modal.saving) closeModal(); }
  };

  /** Sends the blocked request once; if the relay now forwards it, remember that. */
  async function tryRelay(retry) {
    if (state.conn.mode !== "default") return;
    relayOpen = true;
    clientCache = null;
    const retryAction = actions[retry];
    if (retryAction) await retryAction(null);
    const error = retry === "reload-sessions" ? state.remote.error : retry === "conv-reload" ? currentConversation()?.loadError
      : retry === "refresh-job" ? state.jobs.detailError : state.jobs.error;
    if (error && error.kind === "relayRoute") {
      relayOpen = false;
      clientCache = null;
    } else if (!error) {
      store.set(KEYS.relayOpen, "1");
    }
    render();
  }

  function withConv(fn) {
    const conv = currentConversation();
    if (conv) return fn(conv);
    return undefined;
  }

  function withJob(fn) {
    const job = state.jobs.list.find((item) => item.id === state.route.id);
    if (job) fn(job);
  }

  async function runModal(fn) {
    const modal = state.modal;
    if (!modal || modal.busy) return;
    modal.busy = true;
    modal.error = "";
    render();
    try {
      await fn();
    } catch (error) {
      if (state.modal === modal) modal.error = error.message;
    } finally {
      if (state.modal === modal) { modal.busy = false; render(); }
    }
  }

  document.addEventListener("click", (event) => {
    if (!app.contains(event.target)) return;
    const target = event.target.closest("[data-act]");
    if (state.menu && !event.target.closest(".menu-wrap")) {
      state.menu = null;
      if (!target || target.dataset.act === "modal-backdrop") { render(); return; }
    }
    if (!target || (target.dataset.act === "modal-backdrop" && event.target !== target)) return;
    const handler = actions[target.dataset.act];
    if (!handler) return;
    if (target.tagName === "BUTTON" && target.type === "submit" && target.form) return;
    event.preventDefault();
    handler(target, event);
  });

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-form]");
    if (!form) return;
    event.preventDefault();
    switch (form.dataset.form) {
      case "connection": saveForm(); break;
      case "prompt":
        if (state.modal && (!state.modal.required || state.modal.value.trim())) runModal(() => state.modal.onConfirm(state.modal.value));
        break;
      case "job-editor": saveJobEditor(); break;
      case "pair-paste": {
        const error = acceptPairing(state.modal.text);
        if (error) { state.modal.error = error; render(); }
        break;
      }
      case "pair-confirm": savePairing(); break;
      default: break;
    }
  });

  document.addEventListener("input", (event) => {
    const el = event.target;
    const conv = currentConversation();
    switch (el.id) {
      case "draft":
        if (!conv) return;
        conv.draft = el.value;
        autoGrow(el);
        {
          const send = app.querySelector('[data-act="send"]');
          if (send) send.disabled = !canSendMessage(conv);
        }
        return;
      case "revision":
        if (!conv) return;
        conv.revision = el.value;
        autoGrow(el);
        {
          const button = app.querySelector('[data-act="stop-revise"]');
          if (button) button.disabled = conv.isStopping || !conv.revision.trim();
        }
        return;
      case "sessionQuery": state.remote.query = el.value; scheduleRender(); return;
      case "jobQuery": state.jobs.query = el.value; scheduleRender(); return;
      case "messageSearch": if (conv) { conv.searchQuery = el.value; scheduleRender(); } return;
      default: break;
    }
    if (el.dataset.bind) {
      setBinding(el.dataset.bind, el.value);
      if (el.dataset.bind.startsWith("form.") && state.form) { state.form.feedback = ""; state.form.models = []; }
      if (el.dataset.bind.startsWith("modal.") && state.modal) state.modal.error = state.modal.kind === "pairConfirm" ? pairingAddressError(state.modal.payload.url) : "";
      scheduleRender();
    }
  });

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (el.id === "appearance") {
      state.appearance = el.value;
      if (el.value === "system") store.remove(KEYS.appearance); else store.set(KEYS.appearance, el.value);
      applyAppearance();
      render();
    } else if (el.id === "refreshInterval") {
      state.jobs.refreshSeconds = Number(el.value) || 0;
      store.set(KEYS.refresh, String(state.jobs.refreshSeconds));
      render();
    } else if (el.dataset.file === "image" && el.files[0]) {
      const conv = currentConversation();
      if (conv) attachImage(conv, el.files[0]);
    } else if (el.dataset.file === "pair-image" && el.files[0]) {
      decodeImageFile(el.files[0]).then((error) => {
        if (error && state.modal && state.modal.kind === "pairPaste") { state.modal.error = error; render(); }
      });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!overlay.hidden && overlay.innerHTML) { closeScanner(); return; }
      if (state.menu) { state.menu = null; render(); return; }
      if (state.modal && !state.modal.busy && !state.modal.saving) { closeModal(); return; }
      const conv = currentConversation();
      if (conv && conv.searchOpen) { conv.searchOpen = false; conv.highlight = null; render(); }
      return;
    }
    if (event.target.id === "draft" && event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault();
      withConv(sendMessage);
    }
  });

  document.addEventListener("paste", (event) => {
    if (event.target.id !== "draft") return;
    const conv = currentConversation();
    const file = Array.from(event.clipboardData ? event.clipboardData.files : []).find((item) => /^image\//.test(item.type));
    if (!conv || !file) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    attachImage(conv, file);
  });

  document.addEventListener("compositionstart", () => { composing = true; });
  document.addEventListener("compositionend", () => {
    composing = false;
    if (renderDeferred) scheduleRender();
  });

  document.addEventListener("scroll", (event) => {
    const el = event.target;
    if (!(el instanceof Element) || !el.classList.contains("timeline")) return;
    const conv = currentConversation();
    if (!conv || conv.anchor) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    if (conv.follow !== atBottom) {
      conv.follow = atBottom;
      app.querySelector(".latest")?.classList.toggle("show", !atBottom);
    }
  }, true);

  document.addEventListener("visibilitychange", updatePoller);
  window.addEventListener("hashchange", onRoute);

  // Closing the page ends open streams, and the server then stops those runs.
  window.addEventListener("beforeunload", (event) => {
    if (anySending()) { event.preventDefault(); event.returnValue = ""; }
  });

  // ------------------------------------------------------------------ start

  applyAppearance();
  state.route = parseRoute(location.hash);
  state.outcomes = loadOutcomes();
  if (connectionValid()) {
    state.connStatus = "checking";
    checkConnection();
  }
  enterRoute();
  render();
})();
