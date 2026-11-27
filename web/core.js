/*
 * Hermes Web core: protocol, data rules and formatting shared by app.js and protocol_test.js.
 * No DOM access. The rules mirror the iOS 5.0 client: HermesClient.swift, RemoteModels.swift,
 * SessionStream.swift, RemoteConversationModel.swift, InboxView.swift, RemoteWorkspaceModel.swift,
 * PairingPayload.swift and RemoteTimestamp.swift.
 */
(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  else root.HermesCore = core;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "5.0.0";

  // ---------------------------------------------------------------- text helpers

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  const str = (value) => (typeof value === "string" ? value : null);
  const chars = (value) => Array.from(String(value || ""));
  const charCount = (value) => chars(value).length;

  function utf8Length(value) {
    return new TextEncoder().encode(String(value)).length;
  }

  function fold(value) {
    return String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  }

  /** Case- and accent-insensitive containment, like Swift's localizedStandardContains. */
  function matches(query, fields) {
    const needle = fold(String(query || "").trim());
    return !needle || fields.some((field) => fold(field).includes(needle));
  }

  function snippet(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return "无更多说明";
    const all = chars(trimmed);
    return all.length <= 160 ? trimmed : all.slice(0, 160).join("");
  }

  function randomId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ---------------------------------------------------------------- address rules

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

  /** Same rules as serve.normalize_base and the iOS client: the Hermes root without /v1. */
  function normalizeBase(raw) {
    let url;
    try { url = new URL(String(raw || "").trim()); } catch { throw new Error("请输入完整的服务地址，例如 https://hermes.example.com/v1"); }
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

  /** A pairing code for these hosts would only work on the device that shows it. */
  function isLoopbackAddress(raw) {
    let host;
    try { host = new URL(String(raw || "").trim()).hostname.toLowerCase(); } catch { return false; }
    return host === "localhost" || host === "[::1]" || host === "::1" || host.startsWith("127.");
  }

  function hostOf(raw) {
    try { return new URL(String(raw || "").trim()).host; } catch { return String(raw || ""); }
  }

  // ---------------------------------------------------------------- errors

  class HermesError extends Error {
    constructor(message, kind = "error", details = {}) {
      super(message);
      this.name = "HermesError";
      this.kind = kind;
      Object.assign(this, details);
    }
  }

  const errors = {
    invalidResponse: () => new HermesError("服务没有返回有效的 HTTP 响应。", "invalidResponse"),
    emptyResponse: () => new HermesError("Hermes 返回了空内容。", "emptyResponse"),
    incompleteStream: () => new HermesError("连接在回复完成前中断，请重试。", "incompleteStream"),
    invalidStream: () => new HermesError("Hermes 返回的流式数据过大或无效。", "invalidStream"),
    sessionFailed: (reason) => new HermesError(`服务端回复未完成：${reason}。请刷新会话确认记录。`, "sessionFailed", { reason }),
    sessionCancelled: () => new HermesError("服务端已停止本次回复。", "sessionCancelled"),
    server: (status, body) => new HermesError(`服务错误 ${status}：${body}`, "server", { status, body })
  };

  // ---------------------------------------------------------------- workbench relay

  // Routes forwarded by the workbench relay (project-private-web/scripts/hermes-relay.mjs) when
  // this client was published. Only used to explain failures of the default connection: a route
  // outside this list fails the browser's CORS preflight, which looks like a network error.
  const RELAY_ROUTES = [
    [/^\/v1\/models$/, ["GET"]],
    [/^\/api\/sessions$/, ["GET", "POST"]],
    [/^\/api\/sessions\/[\w-]+$/, ["DELETE"]],
    [/^\/api\/sessions\/[\w-]+\/messages$/, ["GET"]],
    [/^\/api\/sessions\/[\w-]+\/chat\/stream$/, ["POST"]],
    [/^\/v1\/runs\/[\w-]+\/(approval|stop)$/, ["POST"]]
  ];

  function relayAllows(method, path) {
    const pathname = String(path).split("?")[0];
    const entry = RELAY_ROUTES.find(([pattern]) => pattern.test(pathname));
    return Boolean(entry && entry[1].includes(method));
  }

  function routeLabel(method, path) {
    const pathname = String(path).split("?")[0].replace(/^(\/api\/(?:sessions|jobs)|\/v1\/runs)\/[^/]+/, "$1/{id}");
    return `${method} ${pathname}`;
  }

  function relayRouteError(method, path) {
    return new HermesError(
      `默认连接的工作台中继没有放行 ${routeLabel(method, path)}。定时任务、会话置顶和重命名需要中继开放对应接口；也可以在设置中改用自定义连接。`,
      "relayRoute", { route: routeLabel(method, path) });
  }

  // ---------------------------------------------------------------- data models

  function normalizeSession(raw) {
    if (!raw || typeof raw !== "object" || raw.id == null || raw.id === "") return null;
    return {
      id: String(raw.id),
      title: str(raw.title),
      source: str(raw.source),
      preview: str(raw.preview),
      lastActive: typeof raw.last_active === "number" && Number.isFinite(raw.last_active) ? raw.last_active : null,
      messageCount: Number.isInteger(raw.message_count) ? raw.message_count : null,
      // null means the server does not report pinning, so the client must not offer it.
      pinned: typeof raw.pinned === "boolean" ? raw.pinned : null
    };
  }

  function sessionTitle(session) {
    const name = session && typeof session.title === "string" ? session.title.trim() : "";
    return name || "未命名会话";
  }

  /** Pinned first, then most recent activity, then id. Later pages replace earlier copies. */
  function mergeSessions(current, incoming) {
    const byId = new Map();
    for (const session of current) byId.set(session.id, session);
    for (const session of incoming) byId.set(session.id, session);
    return Array.from(byId.values()).sort((a, b) => {
      if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1;
      if ((a.lastActive || 0) !== (b.lastActive || 0)) return (b.lastActive || 0) - (a.lastActive || 0);
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /** Pin responses may omit summary fields; keep the ones already known. */
  function mergePinned(session, updated) {
    return {
      id: session.id,
      title: updated.title ?? session.title,
      source: updated.source ?? session.source,
      preview: updated.preview ?? session.preview,
      lastActive: updated.lastActive ?? session.lastActive,
      messageCount: updated.messageCount ?? session.messageCount,
      pinned: updated.pinned
    };
  }

  function filterSessions(sessions, query, pinnedOnly) {
    return sessions.filter((session) => (!pinnedOnly || session.pinned === true) &&
      matches(query, [sessionTitle(session), session.preview || "", session.source || "", session.id]));
  }

  function redactInlineImages(value) {
    return String(value).replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "[图片]");
  }

  function normalizeMessage(raw) {
    const row = raw && typeof raw === "object" ? raw : {};
    let id;
    if (typeof row.id === "number" && Number.isInteger(row.id)) id = String(row.id);
    else if (typeof row.id === "string") id = row.id;
    else id = "local-" + randomId();
    let content = "";
    if (typeof row.content === "string") {
      content = redactInlineImages(row.content);
    } else if (Array.isArray(row.content)) {
      content = row.content.map((part) => {
        if (part && typeof part.text === "string") return redactInlineImages(part.text);
        const type = part && typeof part.type === "string" ? part.type : "内容";
        return type === "image_url" ? "[图片]" : `[${type}]`;
      }).join("\n");
    }
    return {
      id,
      role: str(row.role) || "unknown",
      content,
      timestamp: typeof row.timestamp === "number" ? row.timestamp : null,
      toolName: str(row.tool_name),
      displayKind: str(row.display_kind)
    };
  }

  function messageIsVisible(message) {
    return message.displayKind !== "hidden" && message.content !== "";
  }

  function normalizeMessagePage(body) {
    const data = (Array.isArray(body.data) ? body.data : []).map(normalizeMessage);
    const p = body.pagination && typeof body.pagination === "object" ? body.pagination : null;
    const pagination = p ? {
      limit: Number.isInteger(p.limit) ? p.limit : null,
      offset: Number.isInteger(p.offset) ? p.offset : null,
      returned: Number.isInteger(p.returned) ? p.returned : null
    } : null;
    return {
      data,
      sessionId: str(body.session_id),
      pagination,
      // A full page means older messages may exist.
      hasMore: data.length >= ((pagination && pagination.limit) || 100),
      returned: (pagination && pagination.returned != null) ? pagination.returned : data.length
    };
  }

  function roleLabel(message) {
    switch (message.role) {
      case "user": return "我";
      case "assistant": return "Hermes";
      case "tool": return message.toolName || "工具";
      case "system": return "系统";
      default: return message.role;
    }
  }

  /** Chat row style: user bubble, Hermes reply, or compact tool/system card. */
  function rowKind(role) {
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    if (role === "tool") return "tool";
    return "system";
  }

  function transcript(title, messages) {
    return `# ${title}\n\n` + messages.map((message) => `## ${roleLabel(message)}\n\n${message.content}`).join("\n\n");
  }

  // ---------------------------------------------------------------- scheduled jobs

  const ATTENTION_STATUSES = ["error", "failed", "delivery_failed", "unreachable", "auth_failed"];

  function normalizeJob(raw) {
    if (!raw || typeof raw !== "object" || raw.id == null || raw.id === "") return null;
    const s = raw.schedule && typeof raw.schedule === "object" ? raw.schedule : null;
    return {
      id: String(raw.id),
      name: typeof raw.name === "string" ? raw.name : String(raw.name ?? ""),
      prompt: str(raw.prompt),
      scheduleDisplay: str(raw.schedule_display),
      state: str(raw.state),
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : null,
      nextRunAt: str(raw.next_run_at),
      lastRunAt: str(raw.last_run_at),
      lastStatus: str(raw.last_status),
      lastError: str(raw.last_error),
      schedule: s ? {
        kind: str(s.kind),
        expr: str(s.expr),
        minutes: Number.isInteger(s.minutes) ? s.minutes : null,
        runAt: str(s.run_at)
      } : null
    };
  }

  function jobIsPaused(job) {
    if (job.state === "completed" || job.state === "error") return false;
    return job.enabled === false || job.state === "paused";
  }

  function jobNeedsAttention(job) {
    return job.state === "error" || String(job.lastError || "").trim() !== "" ||
      ATTENTION_STATUSES.includes(job.lastStatus || "");
  }

  function jobLastStatusLabel(job) {
    switch (job.lastStatus) {
      case "ok": case "success": case "completed": return "成功";
      case "error": case "failed": return "失败";
      case "delivery_failed": return "结果投递失败";
      case "unreachable": return "服务不可达";
      case "auth_failed": return "认证失败";
      case "cancelled": return "已取消";
      case "running": return "运行中";
      default: return job.lastStatus == null ? "尚未运行" : job.lastStatus;
    }
  }

  function jobEditableSchedule(job) {
    const s = job.schedule;
    switch (s && s.kind) {
      case "cron": return s.expr ?? job.scheduleDisplay ?? "";
      case "interval": return s.minutes != null ? `every ${s.minutes}m` : (job.scheduleDisplay ?? "");
      case "once": return s.runAt ?? job.scheduleDisplay ?? "";
      default: return job.scheduleDisplay ?? "";
    }
  }

  function jobStatusLabel(job) {
    if (jobIsPaused(job)) return "已暂停";
    switch (job.state) {
      case "scheduled": return "计划中";
      case "running": return "运行中";
      case "completed": return "已完成";
      case "error": return "运行出错";
      default: return job.state ?? "计划中";
    }
  }

  const JOB_FILTERS = [
    { id: "all", title: "全部", includes: () => true },
    { id: "scheduled", title: "计划中", includes: (job) => !jobIsPaused(job) && (job.state === "scheduled" || job.state == null) },
    { id: "running", title: "运行中", includes: (job) => !jobIsPaused(job) && job.state === "running" },
    { id: "paused", title: "已暂停", includes: (job) => jobIsPaused(job) },
    { id: "attention", title: "需关注", includes: (job) => jobNeedsAttention(job) },
    { id: "completed", title: "已完成", includes: (job) => !jobIsPaused(job) && job.state === "completed" }
  ];

  function jobFilter(id) {
    return JOB_FILTERS.find((filter) => filter.id === id) || JOB_FILTERS[0];
  }

  function jobStatusTone(job) {
    if (jobNeedsAttention(job)) return "warning";
    if (jobIsPaused(job)) return "neutral";
    return jobFilter("running").includes(job) ? "info" : "accent";
  }

  function filterJobs(jobs, query, filterId) {
    const filter = jobFilter(filterId);
    return jobs.filter((job) => filter.includes(job) &&
      matches(query, [job.name, job.prompt || "", job.scheduleDisplay || "", job.id]));
  }

  function jobOverview(jobs) {
    return {
      running: jobs.filter(jobFilter("running").includes).length,
      attention: jobs.filter(jobNeedsAttention).length,
      paused: jobs.filter(jobIsPaused).length
    };
  }

  function dedupeJobs(jobs) {
    const seen = new Set();
    return jobs.filter((job) => !seen.has(job.id) && seen.add(job.id));
  }

  /** Copying never carries an old one-shot time, results or delivery settings. */
  function jobCopyDraft(job) {
    return {
      name: chars(job.name).slice(0, 195).join("") + " · 副本",
      prompt: job.prompt ?? "",
      schedule: job.schedule && job.schedule.kind === "once" ? "" : jobEditableSchedule(job)
    };
  }

  /** Create sends every field; edit sends only the trimmed fields that changed. */
  function jobEditorFields(values, job, copying) {
    const trimmed = {
      name: String(values.name || "").trim(),
      prompt: String(values.prompt || "").trim(),
      schedule: String(values.schedule || "").trim()
    };
    if (!job || copying) return trimmed;
    const original = { name: job.name, prompt: job.prompt ?? "", schedule: jobEditableSchedule(job) };
    const changed = {};
    for (const key of Object.keys(trimmed)) if (original[key] !== trimmed[key]) changed[key] = trimmed[key];
    return changed;
  }

  function jobEditorCanSave(values, job, copying) {
    const editing = Boolean(job) && !copying;
    const name = String(values.name || "");
    const prompt = String(values.prompt || "");
    const schedule = String(values.schedule || "");
    return name.trim() !== "" && charCount(name) <= 200 &&
      (editing || prompt.trim() !== "") && charCount(prompt) <= 5000 &&
      schedule.trim() !== "" && Object.keys(jobEditorFields(values, job, copying)).length > 0;
  }

  // Inbox: running jobs and recent failures are shown; only non-running ones count as pending.
  function jobIsRunning(job) {
    return job.lastStatus === "running" || job.state === "running";
  }

  function jobIsAttention(job) {
    return jobIsRunning(job) || ATTENTION_STATUSES.includes(job.lastStatus || "") || jobNeedsAttention(job);
  }

  function pendingCount(approvalCount, jobs) {
    return approvalCount + jobs.filter((job) => jobIsAttention(job) && !jobIsRunning(job)).length;
  }

  const REFRESH_INTERVALS = [0, 30, 60, 120];

  function refreshTitle(seconds) {
    return seconds ? `每 ${seconds} 秒` : "手动刷新";
  }

  /** Polling slows down after failures: 1x, 2x, 4x, 8x, capped at five minutes. */
  function refreshDelay(seconds, failures) {
    if (!seconds) return 0;
    return Math.min(300, seconds * (1 << Math.min(3, Math.max(0, failures))));
  }

  // ---------------------------------------------------------------- timestamps

  const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/;

  /** Only timestamps with an explicit zone are converted; a naive server time is never guessed. */
  function parseRemoteTimestamp(raw) {
    if (raw == null) return null;
    const value = String(raw).trim();
    const m = value.match(TIMESTAMP);
    if (!m) return null;
    const fraction = m[7] ? "." + (m[7].slice(1) + "000").slice(0, 3) : "";
    let zone = m[8];
    if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ":" + zone.slice(3);
    if (zone === "z") zone = "Z";
    const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${fraction}${zone}`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function displayRemoteTimestamp(raw, timeZone) {
    if (raw == null || raw === "") return "未提供";
    const date = parseRemoteTimestamp(raw);
    if (!date) return String(raw);
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
  }

  function relativeTime(date, now = new Date()) {
    const seconds = (date.getTime() - now.getTime()) / 1000;
    const abs = Math.abs(seconds);
    if (abs < 45) return "刚刚";
    const format = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
    const units = [["minute", 60, 45 * 60], ["hour", 3600, 22 * 3600], ["day", 86400, 6 * 86400],
      ["week", 604800, 27 * 86400], ["month", 2629800, 320 * 86400], ["year", 31557600, Infinity]];
    for (const [unit, size, limit] of units) {
      if (abs < limit) return format.format(Math.round(seconds / size), unit);
    }
    return format.format(Math.round(seconds / 31557600), "year");
  }

  function clockTime(date) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
  }

  // ---------------------------------------------------------------- approvals

  function normalizeApproval(payload, fallbackRunId) {
    if (!payload || typeof payload !== "object") return null;
    const runId = str(payload.run_id) || fallbackRunId || null;
    if (!runId) return null;
    const approval = {
      runId,
      requestId: str(payload.request_id),
      command: str(payload.command),
      description: str(payload.description),
      choices: Array.isArray(payload.choices) ? payload.choices.filter((choice) => typeof choice === "string") : null
    };
    approval.id = approval.requestId ?? (runId + ":" + (approval.command ?? approval.description ?? ""));
    return approval;
  }

  /** Buttons offered by the approval card. Wider grants need a command to review. Deny is always offered. */
  function approvalActions(approval) {
    const allowed = approval.choices ?? ["once", "deny"];
    const hasCommand = Boolean(approval.command);
    return {
      once: allowed.includes("once"),
      session: allowed.includes("session") && hasCommand,
      always: allowed.includes("always") && hasCommand,
      deny: true
    };
  }

  /** The inbox accepts a choice only when the server offered it. */
  function approvalChoiceAllowed(approval, choice) {
    if (choice !== "deny" && !(approval.choices ?? ["once", "deny"]).includes(choice)) return false;
    if ((choice === "session" || choice === "always") && !approval.command) return false;
    return true;
  }

  function approvalProgress(choice) {
    switch (choice) {
      case "deny": return "已拒绝，等待服务端继续…";
      case "session": return "已允许本次会话，正在继续…";
      case "always": return "已始终允许，正在继续…";
      default: return "已允许本次操作，正在继续…";
    }
  }

  /** Tokens that look like paths: contain "/" or start with "~". Not a server diff. */
  function approvalPaths(command) {
    const seen = new Set();
    const result = [];
    for (const raw of String(command || "").split(/\s+/)) {
      if (!raw) continue;
      const token = raw.replace(/^["'`([{]+/, "").replace(/["'`)\]},;:]+$/, "");
      if (!(token.includes("/") || token.startsWith("~"))) continue;
      if (!seen.has(token)) { seen.add(token); result.push(token); }
    }
    return result;
  }

  // ---------------------------------------------------------------- session stream

  class SSEParser {
    constructor() { this.event = null; this.data = []; }

    consume(line) {
      if (line === "") return this.flush();
      if (line.startsWith(":")) return null;
      const index = line.indexOf(":");
      const name = index < 0 ? line : line.slice(0, index);
      let value = index < 0 ? "" : line.slice(index + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (name === "event") this.event = value;
      else if (name === "data") this.data.push(value);
      return null;
    }

    flush() {
      const frame = this.data.length ? { event: this.event, data: this.data.join("\n") } : null;
      this.event = null;
      this.data = [];
      return frame;
    }
  }

  const STREAM_EVENTS = new Set(["run.started", "assistant.delta", "assistant.completed", "assistant.commentary",
    "tool.started", "tool.completed", "tool.failed", "run.completed", "run.failed",
    "run.cancelled", "run.interrupted", "error", "done"]);

  function framePayload(data) {
    let value;
    try { value = JSON.parse(data); } catch { throw errors.invalidStream(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw errors.invalidStream();
    return value;
  }

  /** The terminal run status, not an assistant text event, decides whether a turn succeeded. */
  class SessionStreamDecoder {
    constructor(sessionId) {
      this.sessionId = sessionId;
      this.deltas = "";
      this.finalContent = null;
      this.runId = null;
      this.result = null;
    }

    consume(frame) {
      const name = frame.event;
      if (name == null) return [];
      if (name === "approval.request") {
        const approval = normalizeApproval(framePayload(frame.data), this.runId);
        if (!approval) throw errors.invalidStream();
        return [{ type: "approval", approval }];
      }
      if (!STREAM_EVENTS.has(name)) return [];
      const p = framePayload(frame.data);
      const events = [];
      const sessionId = str(p.session_id);
      if (sessionId && sessionId !== this.sessionId) {
        this.sessionId = sessionId;
        events.push({ type: "sessionChanged", id: sessionId });
      }
      switch (name) {
        case "run.started":
          if (str(p.run_id)) { this.runId = p.run_id; events.push({ type: "started", runId: p.run_id }); }
          break;
        case "assistant.delta":
          if (typeof p.delta === "string") { this.deltas += p.delta; events.push({ type: "delta", text: p.delta }); }
          break;
        case "assistant.commentary":
          if (typeof p.text === "string") events.push({ type: "commentary", text: p.text });
          break;
        case "tool.started": events.push({ type: "progress", text: `正在运行：${str(p.tool_name) ?? "工具"}` }); break;
        case "tool.completed": events.push({ type: "progress", text: `工具已完成：${str(p.tool_name) ?? "工具"}` }); break;
        case "tool.failed": events.push({ type: "progress", text: `工具运行失败：${str(p.tool_name) ?? "工具"}` }); break;
        case "assistant.completed": this.finalContent = str(p.content); break;
        case "run.completed": {
          if (p.completed === false || p.partial === true || p.interrupted === true) {
            throw errors.sessionFailed(str(p.turn_exit_reason) ?? "回复未完成");
          }
          const content = this.finalContent ?? this.deltas;
          if (!content.trim()) throw errors.emptyResponse();
          this.result = { sessionId: this.sessionId, content };
          break;
        }
        case "run.failed": throw errors.sessionFailed(str(p.turn_exit_reason) ?? str(p.message) ?? "服务端执行失败");
        case "run.cancelled": case "run.interrupted": throw errors.sessionCancelled();
        case "error": throw errors.sessionFailed(str(p.message) ?? "服务端执行失败");
        case "done": if (!this.result) throw errors.incompleteStream(); break;
        default: break;
      }
      return events;
    }
  }

  /** Server sessions own their context: send only the new turn, with an optional JPEG data URL. */
  function sessionChatBody(input, imageDataURL) {
    if (!imageDataURL) return { input };
    const parts = [];
    if (input) parts.push({ type: "text", text: input });
    parts.push({ type: "image_url", image_url: { url: imageDataURL } });
    return { input: parts };
  }

  /**
   * After a failed send, find which parts of the turn the server did not save.
   * The client never resends; unsaved parts go back into the composer.
   */
  function missingParts({ knownIds, messages, input, hadImage, confirmed }) {
    if (!confirmed) return { text: input !== "", image: Boolean(hadImage) };
    const fresh = messages.filter((message) => message.role === "user" && !knownIds.has(message.id));
    const textSaved = input === "" || fresh.some((message) => message.content.includes(input));
    const imageSaved = !hadImage || fresh.some((message) => message.content.includes("[screenshot]"));
    return { text: !textSaved, image: !imageSaved };
  }

  // ---------------------------------------------------------------- API client

  /**
   * target: { mode: "default" | "custom", base, headers, networkHint?: () => string, relayListOnly?: boolean }
   * Paths, queries and bodies match the iOS HermesClient.
   */
  function createClient(target, options = {}) {
    const fetchImpl = options.fetch || ((...args) => fetch(...args));
    const enc = encodeURIComponent;

    async function networkFailure(method, path, error) {
      if (target.mode === "default") {
        if (!relayAllows(method, path)) {
          try {
            const probe = await fetchImpl(target.base + "/v1/models", { method: "GET", headers: Object.assign({}, target.headers) });
            if (probe.ok) return relayRouteError(method, path);
          } catch { /* the connection itself is down */ }
        }
        return new HermesError("无法连接默认 Hermes。请确认 Tailscale 已连接，且 Hermes 地址走直连。", "network");
      }
      const hint = target.networkHint ? target.networkHint() : "";
      return new HermesError(`无法连接 Hermes（${(error && error.message) || "网络错误"}）。${hint}`, "network");
    }

    async function open(method, path, { query, body, accept, signal } = {}) {
      let url = target.base + path;
      if (query) url += "?" + new URLSearchParams(query).toString();
      // A refused CORS preflight is logged by the browser on every attempt, so known gaps are not retried.
      if (target.mode === "default" && target.relayListOnly && !relayAllows(method, path)) throw relayRouteError(method, path);
      const headers = Object.assign({}, target.headers);
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (accept) headers.Accept = accept;
      let response;
      try {
        response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        throw await networkFailure(method, path, error);
      }
      if (target.mode === "default" && (response.status === 404 || response.status === 405) && !relayAllows(method, path)) {
        const text = await response.text().catch(() => "");
        if (/route_not_found|method_not_allowed/.test(text)) throw relayRouteError(method, path);
        throw errors.server(response.status, text.slice(0, 300));
      }
      return response;
    }

    async function json(method, path, opts) {
      const response = await open(method, path, opts);
      const text = await response.text();
      if (!response.ok) throw errors.server(response.status, text.slice(0, 300));
      try { return text ? JSON.parse(text) : {}; } catch { throw errors.invalidResponse(); }
    }

    function requireSession(body) {
      const session = normalizeSession(body && body.session);
      if (!session) throw errors.invalidResponse();
      return session;
    }

    function requireJob(body) {
      const job = normalizeJob(body && body.job);
      if (!job) throw errors.invalidResponse();
      return job;
    }

    async function streamSession(sessionId, input, imageDataURL, onEvent, signal) {
      const response = await open("POST", `/api/sessions/${enc(sessionId)}/chat/stream`, {
        body: sessionChatBody(input, imageDataURL), accept: "text/event-stream", signal
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw errors.server(response.status, text.slice(0, 300));
      }
      if (!response.body || !response.body.getReader) throw errors.invalidResponse();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SSEParser();
      const session = new SessionStreamDecoder(sessionId);
      let pending = "";
      const take = (line) => {
        const frame = parser.consume(line.endsWith("\r") ? line.slice(0, -1) : line);
        if (!frame) return false;
        for (const event of session.consume(frame)) onEvent(event);
        return Boolean(session.result);
      };
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let index = pending.indexOf("\n");
          while (index >= 0) {
            const line = pending.slice(0, index);
            pending = pending.slice(index + 1);
            if (take(line)) return session.result;
            index = pending.indexOf("\n");
          }
          if (pending.length > 1000000) throw errors.invalidStream();
        }
        pending += decoder.decode();
        if (pending && take(pending)) return session.result;
        const frame = parser.flush();
        if (frame) for (const event of session.consume(frame)) onEvent(event);
        if (!session.result) throw errors.incompleteStream();
        return session.result;
      } finally {
        reader.cancel().catch(() => {});
      }
    }

    return {
      target,
      async models() {
        const body = await json("GET", "/v1/models");
        const seen = new Set();
        return (Array.isArray(body.data) ? body.data : [])
          .map((model) => (model && typeof model.id === "string" ? model.id : ""))
          .filter((id) => id && !seen.has(id) && seen.add(id));
      },
      async sessions(offset = 0) {
        const body = await json("GET", "/api/sessions", {
          query: [["limit", "50"], ["offset", String(offset)], ["include_children", "true"]]
        });
        if (!Array.isArray(body.data)) throw errors.invalidResponse();
        return { data: body.data.map(normalizeSession).filter(Boolean), hasMore: body.has_more === true };
      },
      async session(id) {
        return requireSession(await json("GET", `/api/sessions/${enc(id)}`));
      },
      async messages(id, offset = 0) {
        const body = await json("GET", `/api/sessions/${enc(id)}/messages`, {
          query: [["order", "latest"], ["limit", "100"], ["offset", String(offset)],
            ["include_compacted", "true"], ["inline_images", "false"]]
        });
        if (!Array.isArray(body.data)) throw errors.invalidResponse();
        return normalizeMessagePage(body);
      },
      async createSession(title) {
        return requireSession(await json("POST", "/api/sessions", { body: { title } }));
      },
      async renameSession(id, title) {
        return requireSession(await json("PATCH", `/api/sessions/${enc(id)}`, { body: { title } }));
      },
      async setSessionPinned(id, pinned) {
        const session = requireSession(await json("PATCH", `/api/sessions/${enc(id)}`, { body: { pinned } }));
        if (session.pinned !== pinned) throw errors.invalidResponse();
        return session;
      },
      async deleteSession(id) {
        const body = await json("DELETE", `/api/sessions/${enc(id)}`);
        if (body.deleted !== true) throw errors.invalidResponse();
      },
      async jobs() {
        const body = await json("GET", "/api/jobs", { query: [["include_disabled", "true"]] });
        if (!Array.isArray(body.jobs)) throw errors.invalidResponse();
        return body.jobs.map(normalizeJob).filter(Boolean);
      },
      async job(id) {
        return requireJob(await json("GET", `/api/jobs/${enc(id)}`));
      },
      async createJob({ name, schedule, prompt }) {
        return requireJob(await json("POST", "/api/jobs", { body: { name, schedule, prompt, deliver: "local" } }));
      },
      async updateJob(id, fields) {
        return requireJob(await json("PATCH", `/api/jobs/${enc(id)}`, { body: fields }));
      },
      async setJobPaused(id, paused) {
        return requireJob(await json("POST", `/api/jobs/${enc(id)}/${paused ? "pause" : "resume"}`));
      },
      // The run endpoint acknowledges scheduling; completion shows up on a later refresh.
      async runJob(id) {
        return requireJob(await json("POST", `/api/jobs/${enc(id)}/run`));
      },
      async deleteJob(id) {
        const body = await json("DELETE", `/api/jobs/${enc(id)}`);
        if (body.ok !== true) throw errors.invalidResponse();
      },
      async stopRun(runId) {
        const body = await json("POST", `/v1/runs/${enc(runId)}/stop`);
        if (typeof body.status !== "string") throw errors.invalidResponse();
      },
      async resolveApproval(approval, choice) {
        const payload = { choice };
        if (approval.requestId) payload.request_id = approval.requestId;
        const body = await json("POST", `/v1/runs/${enc(approval.runId)}/approval`, { body: payload });
        if (!(Number(body.resolved) > 0)) throw errors.invalidResponse();
      },
      streamSession
    };
  }

  // ---------------------------------------------------------------- pairing (iOS QR payload)

  const PAIRING_VERSION = 1;
  const PAIRING_DEFAULT_NAME = "扫码连接";
  const PAIRING_MAX_BYTES = 8192;
  const PAIRING_MESSAGES = {
    invalid: "配对码无效。",
    unknownVersion: "配对码版本不受支持。",
    emptyURL: "配对码缺少服务地址。",
    emptyKey: "配对码缺少密钥。"
  };

  function pairingError(kind) {
    return new HermesError(PAIRING_MESSAGES[kind], "pairing." + kind);
  }

  /** UTF-8 JSON {"v":1,"name":"…","url":"…","key":"…"} with no other fields, as shown by iOS. */
  function encodePairing(name, url, key) {
    const cleanURL = String(url || "").trim();
    const cleanKey = String(key || "").trim();
    if (!cleanURL) throw pairingError("emptyURL");
    if (!cleanKey) throw pairingError("emptyKey");
    const cleanName = String(name || "").trim() || PAIRING_DEFAULT_NAME;
    return `{"v":${PAIRING_VERSION},"name":${JSON.stringify(cleanName)},"url":${JSON.stringify(cleanURL)},"key":${JSON.stringify(cleanKey)}}`;
  }

  function decodePairing(raw) {
    const input = String(raw == null ? "" : raw);
    if (utf8Length(input) > PAIRING_MAX_BYTES) throw pairingError("invalid");
    const text = input.trim().replace(/^\uFEFF/, "");
    let object;
    try { object = JSON.parse(text); } catch { throw pairingError("invalid"); }
    if (!object || typeof object !== "object" || Array.isArray(object)) throw pairingError("invalid");
    const allowed = ["v", "name", "url", "key"];
    if (Object.keys(object).some((key) => !allowed.includes(key)) || !("v" in object) || !("url" in object) || !("key" in object)) {
      throw pairingError("invalid");
    }
    const version = object.v;
    if (typeof version !== "number" || !Number.isFinite(version) || !Number.isInteger(version)) throw pairingError("invalid");
    if (version !== PAIRING_VERSION) throw pairingError("unknownVersion");
    if (typeof object.url !== "string" || typeof object.key !== "string") throw pairingError("invalid");
    const url = object.url.trim();
    const key = object.key.trim();
    if (!url) throw pairingError("emptyURL");
    if (!key) throw pairingError("emptyKey");
    let name = PAIRING_DEFAULT_NAME;
    if (object.name !== undefined) {
      if (typeof object.name !== "string") throw pairingError("invalid");
      name = object.name.trim() || PAIRING_DEFAULT_NAME;
    }
    return { name, url, key };
  }

  /** Accepts the QR text itself, or a link that carries it in a "pair" parameter. */
  function pairingText(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !text.startsWith("{")) {
      try {
        const url = new URL(text);
        const value = new URLSearchParams(url.hash.replace(/^#/, "")).get("pair") ?? url.searchParams.get("pair");
        if (value) return value;
      } catch { /* not a link */ }
    }
    return String(raw == null ? "" : raw);
  }

  // ---------------------------------------------------------------- QR code (byte mode, level Q)

  // Error correction codewords per block and block counts for level Q, versions 1–40 (ISO/IEC 18004).
  const QR_Q_ECC = [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  const QR_Q_BLOCKS = [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68];
  const QR_Q_FORMAT = 3;

  function qrRawModules(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const align = Math.floor(version / 7) + 2;
      result -= (25 * align - 10) * align - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  function qrDataCodewords(version) {
    return Math.floor(qrRawModules(version) / 8) - QR_Q_ECC[version] * QR_Q_BLOCKS[version];
  }

  function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
    }
    return result;
  }

  function qrEncode(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let version = 1;
    for (; version <= 40; version++) {
      const countBits = version <= 9 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= qrDataCodewords(version) * 8) break;
    }
    if (version > 40) throw new HermesError("配对码内容过长，无法生成二维码。", "qr.tooLong");
    const size = version * 4 + 17;
    const capacity = qrDataCodewords(version) * 8;

    // Data bits: byte mode, character count, data, terminator and padding.
    const bits = [];
    const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0x4, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const byte of bytes) push(byte, 8);
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

    // Error correction and interleaving.
    const numBlocks = QR_Q_BLOCKS[version];
    const eccLen = QR_Q_ECC[version];
    const rawCodewords = Math.floor(qrRawModules(version) / 8);
    const numShort = numBlocks - (rawCodewords % numBlocks);
    const shortLen = Math.floor(rawCodewords / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const block = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += block.length;
      const ecc = rsRemainder(block, divisor);
      if (i < numShort) block.push(0);
      blocks.push(block.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortLen - eccLen || j >= numShort) codewords.push(block[i]);
      });
    }

    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx; const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    if (version > 1) {
      const count = Math.floor(version / 7) + 2;
      const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
      const positions = [6];
      for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos);
      positions.forEach((px, i) => positions.forEach((py, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }));
    }
    const drawFormat = (mask) => {
      const value = (QR_Q_FORMAT << 3) | mask;
      let rem = value;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const format = ((value << 10) | rem) ^ 0x5412;
      const bit = (i) => ((format >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const value = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((value >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
        set(a, b, dark); set(b, a, dark);
      }
    }

    // Codewords in the zigzag order.
    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && index < codewords.length * 8) {
            modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
            index++;
          }
        }
      }
    }

    const maskFns = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    ];
    const applyMask = (mask) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskFns[mask](x, y)) modules[y][x] = !modules[y][x];
      }
    };
    let best = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(mask);
      drawFormat(mask);
      const score = qrPenalty(modules, size);
      if (score < bestScore) { best = mask; bestScore = score; }
      applyMask(mask);
    }
    applyMask(best);
    drawFormat(best);
    return { version, size, modules };
  }

  function qrPenalty(modules, size) {
    let result = 0;
    const addHistory = (run, history) => {
      if (history[0] === 0) run += size;
      history.pop();
      history.unshift(run);
    };
    const countFinder = (h) => {
      const n = h[1];
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
    };
    const line = (get) => {
      let runColor = false; let run = 0; const history = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < size; i++) {
        if (get(i) === runColor) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          addHistory(run, history);
          if (!runColor) result += countFinder(history) * 40;
          runColor = get(i);
          run = 1;
        }
      }
      if (runColor) { addHistory(run, history); run = 0; }
      addHistory(run + size, history);
      result += countFinder(history) * 40;
    };
    for (let y = 0; y < size; y++) line((x) => modules[y][x]);
    for (let x = 0; x < size; x++) line((y) => modules[y][x]);
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) dark++;
        if (x < size - 1 && y < size - 1) {
          const c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
        }
      }
    }
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }

  /** SVG markup with a four-module quiet zone; always dark on white so cameras can read it. */
  function qrSvg(text, label = "配对码") {
    const { size, modules } = qrEncode(text);
    const quiet = 4;
    const full = size + quiet * 2;
    let path = "";
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}"><rect width="${full}" height="${full}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  // ---------------------------------------------------------------- Markdown (safe subset)

  function fenceOpening(line) {
    const spaces = line.length - line.replace(/^ +/, "").length;
    if (spaces > 3) return null;
    const trimmed = line.slice(spaces);
    const marker = trimmed[0];
    if (marker !== "`" && marker !== "~") return null;
    const length = trimmed.length - trimmed.replace(new RegExp(`^\\${marker}+`), "").length;
    if (length < 3) return null;
    const info = trimmed.slice(length).trim();
    if (marker === "`" && info.includes("`")) return null;
    const language = info ? info.split(/\s+/)[0].slice(0, 40) : null;
    return { marker, length, language };
  }

  function fenceClosing(line, fence) {
    const spaces = line.length - line.replace(/^ +/, "").length;
    if (spaces > 3) return false;
    const trimmed = line.slice(spaces);
    let length = 0;
    while (trimmed[length] === fence.marker) length++;
    return length >= fence.length && trimmed.slice(length).trim() === "";
  }

  /** Fenced code stays literal, including indentation; an unclosed fence runs to the end. */
  function markdownBlocks(text) {
    const lines = String(text).split("\n");
    const result = [];
    let prose = "";
    let code = "";
    let open = null;
    lines.forEach((line, index) => {
      const raw = line + (index < lines.length - 1 ? "\n" : "");
      if (open) {
        if (fenceClosing(line, open)) { result.push({ kind: "code", language: open.language, text: code }); code = ""; open = null; }
        else code += raw;
      } else {
        const fence = fenceOpening(line);
        if (fence) {
          if (prose) { result.push({ kind: "prose", text: prose }); prose = ""; }
          open = fence;
        } else prose += raw;
      }
    });
    if (open) result.push({ kind: "code", language: open.language, text: code });
    if (prose) result.push({ kind: "prose", text: prose });
    return result;
  }

  function safeLink(url) {
    try {
      const parsed = new URL(url);
      return ["http:", "https:", "mailto:"].includes(parsed.protocol);
    } catch { return false; }
  }

  function linkHTML(url, labelHTML) {
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${labelHTML}</a>`;
  }

  function inlineMarkdown(text, allowLinks = true) {
    const slots = [];
    const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    let s = String(text).replace(/\u0000/g, "");
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, ticks, code) => keep(`<code>${esc(code.replace(/^ ([\s\S]*\S[\s\S]*) $/, "$1"))}</code>`));
    if (allowLinks) {
      s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
        const label = esc(`[图片${alt ? "：" + alt : ""}]`);
        return keep(safeLink(url) ? linkHTML(url, label) : label);
      });
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (all, label, url) => (
        safeLink(url) ? keep(linkHTML(url, inlineMarkdown(label, false))) : all));
      s = s.replace(/<(https?:\/\/[^\s<>]+)>/g, (_, url) => keep(linkHTML(url, esc(url))));
      s = s.replace(/https?:\/\/[^\s<>\u0000]+/g, (url) => {
        const clean = url.replace(/[).,;:!?，。；：！？）】」』"'*_~]+$/, "");
        if (!safeLink(clean)) return url;
        return keep(linkHTML(clean, esc(clean))) + url.slice(clean.length);
      });
    }
    s = esc(s)
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, "$1<em>$2</em>")
      .replace(/(^|[^_\p{L}\p{N}])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, "$1<em>$2</em>")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    for (let depth = 0; depth < 6 && s.includes("\u0000"); depth++) {
      s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
    }
    return s;
  }

  const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
  const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE = /^ {0,3}>/;

  function tableCells(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  }

  function tableDivider(line) {
    if (!/^[\s|:-]+$/.test(line) || !line.includes("-")) return null;
    const cells = tableCells(line);
    if (!cells.every((cell) => /^:?-+:?$/.test(cell))) return null;
    return cells.map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""));
  }

  function tableStart(lines, i) {
    if (i + 1 >= lines.length || !lines[i].includes("|")) return null;
    const align = tableDivider(lines[i + 1]);
    if (!align || align.length !== tableCells(lines[i]).length) return null;
    return align;
  }

  function blockStarts(lines, i) {
    const line = lines[i];
    return HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || Boolean(tableStart(lines, i));
  }

  function renderList(lines, start) {
    const first = lines[start].match(LIST_ITEM);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const sameKind = (m) => m && m[1].length === indent && /\d/.test(m[2]) === ordered;
    const items = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(LIST_ITEM);
      if (sameKind(m)) { items.push([m[3]]); i++; continue; }
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const next = j < lines.length ? lines[j] : "";
        const nextIndent = next.length - next.replace(/^ +/, "").length;
        if (j < lines.length && (sameKind(next.match(LIST_ITEM)) || nextIndent > indent)) {
          items[items.length - 1].push("");
          i = j;
          continue;
        }
        break;
      }
      const lineIndent = line.length - line.replace(/^ +/, "").length;
      if (lineIndent > indent) { items[items.length - 1].push(line.slice(indent)); i++; continue; }
      if (!m && !blockStarts(lines, i)) { items[items.length - 1].push(line.trim()); i++; continue; }
      break;
    }
    const tag = ordered ? "ol" : "ul";
    const startNumber = ordered ? parseInt(first[2], 10) : 1;
    const startAttr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : "";
    const body = items.map((itemLines) => {
      let firstLine = itemLines[0];
      let check = "";
      const task = firstLine.match(/^\[([ xX])\][ \t]+(.*)$/);
      if (task) {
        check = `<span class="md-check" aria-hidden="true">${task[1] === " " ? "☐" : "☑"}</span>`;
        firstLine = task[2];
      }
      const inner = renderProse([firstLine].concat(itemLines.slice(1)).join("\n"));
      return `<li>${check}${inner.replace(/^<p>([\s\S]*?)<\/p>/, "$1")}</li>`;
    }).join("");
    return [`<${tag}${startAttr}>${body}</${tag}>`, i];
  }

  function renderProse(text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const heading = line.match(HEADING);
      if (heading) {
        if (heading[2] && heading[2].trim()) out.push(`<h${heading[1].length}>${inlineMarkdown(heading[2].trim())}</h${heading[1].length}>`);
        i++;
        continue;
      }
      if (RULE.test(line)) { out.push("<hr>"); i++; continue; }
      if (QUOTE.test(line)) {
        const quoted = [];
        while (i < lines.length && QUOTE.test(lines[i])) { quoted.push(lines[i].replace(/^ {0,3}> ?/, "")); i++; }
        out.push(`<blockquote>${renderProse(quoted.join("\n"))}</blockquote>`);
        continue;
      }
      const align = tableStart(lines, i);
      if (align) {
        const cellAttr = (k) => (align[k] ? ` style="text-align:${align[k]}"` : "");
        const header = tableCells(line).map((cell, k) => `<th${cellAttr(k)}>${inlineMarkdown(cell)}</th>`).join("");
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          const cells = tableCells(lines[i]);
          rows.push(`<tr>${align.map((_, k) => `<td${cellAttr(k)}>${inlineMarkdown(cells[k] || "")}</td>`).join("")}</tr>`);
          i++;
        }
        out.push(`<div class="md-table"><table><thead><tr>${header}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`);
        continue;
      }
      if (LIST_ITEM.test(line)) {
        const [html, next] = renderList(lines, i);
        out.push(html);
        i = next;
        continue;
      }
      const paragraph = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !blockStarts(lines, i)) { paragraph.push(lines[i].trim()); i++; }
      out.push(`<p>${paragraph.map((part) => inlineMarkdown(part)).join("<br>")}</p>`);
    }
    return out.join("");
  }

  function codeBlockHTML(language, code) {
    return `<div class="code-block"><div class="code-head"><span>${esc(language || "代码")}</span>` +
      `<button type="button" class="code-copy" data-act="copy-code">复制</button></div>` +
      `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre></div>`;
  }

  /** Escapes everything first; links are limited to http, https and mailto, and images are not loaded. */
  function renderMarkdown(text) {
    return markdownBlocks(text).map((block) => (
      block.kind === "code" ? codeBlockHTML(block.language, block.text) : renderProse(block.text)
    )).join("");
  }

  // ---------------------------------------------------------------- message search

  function messageSearchHits(entries, query) {
    const needle = String(query || "").trim();
    if (!needle) return [];
    const lowerNeedle = needle.toLocaleLowerCase();
    return entries.map((entry) => {
      const text = entry.text;
      const lower = text.toLocaleLowerCase();
      const index = lower.length === text.length ? lower.indexOf(lowerNeedle) : text.indexOf(needle);
      if (index < 0) return null;
      const start = Math.max(0, index - 48);
      const end = Math.min(text.length, index + needle.length + 80);
      return {
        entry,
        before: (start > 0 ? "…" : "") + text.slice(start, index),
        match: text.slice(index, index + needle.length),
        after: text.slice(index + needle.length, end) + (end < text.length ? "…" : "")
      };
    }).filter(Boolean);
  }

  return {
    VERSION,
    esc, matches, snippet, charCount, utf8Length,
    httpAllowed, normalizeBase, isLoopbackAddress, hostOf,
    HermesError, errors, RELAY_ROUTES, relayAllows, routeLabel,
    normalizeSession, sessionTitle, mergeSessions, mergePinned, filterSessions,
    redactInlineImages, normalizeMessage, messageIsVisible, normalizeMessagePage, roleLabel, rowKind, transcript,
    normalizeJob, jobIsPaused, jobNeedsAttention, jobLastStatusLabel, jobEditableSchedule, jobStatusLabel,
    JOB_FILTERS, jobFilter, jobStatusTone, filterJobs, jobOverview, dedupeJobs, jobCopyDraft,
    jobEditorFields, jobEditorCanSave, jobIsRunning, jobIsAttention, pendingCount,
    REFRESH_INTERVALS, refreshTitle, refreshDelay,
    parseRemoteTimestamp, displayRemoteTimestamp, relativeTime, clockTime,
    normalizeApproval, approvalActions, approvalChoiceAllowed, approvalProgress, approvalPaths,
    SSEParser, SessionStreamDecoder, sessionChatBody, missingParts, createClient,
    PAIRING_DEFAULT_NAME, encodePairing, decodePairing, pairingText,
    qrEncode, qrSvg, renderMarkdown, markdownBlocks, inlineMarkdown, messageSearchHits
  };
});
