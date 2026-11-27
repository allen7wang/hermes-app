// Run by protocol_test.py. Checks web/core.js against the iOS 5.0 client rules (vectors from
// HermesTests), then calls every API through serve.py's proxy against the mock Hermes server.
"use strict";

const assert = require("node:assert/strict");
const Core = require("./core.js");

const PROXY = process.env.HERMES_PROXY;
const MOCK = process.env.HERMES_MOCK;
const KEY = process.env.HERMES_KEY;
const RELAY_ORIGIN = process.env.HERMES_RELAY_ORIGIN;

let passed = 0;
const failed = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed.push(`${name}: ${error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : error}`);
  }
}

async function rejects(promise, kind) {
  try {
    await promise;
  } catch (error) {
    if (kind) assert.equal(error.kind, kind, error.message);
    return error;
  }
  throw new Error(`expected ${kind || "an error"}`);
}

function throwsKind(fn, kind) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.kind, kind, error.message);
    return error;
  }
  throw new Error(`expected ${kind}`);
}

function job(fields) {
  return Core.normalizeJob(Object.assign({ name: "任务" }, fields));
}

// 1x1 JPEG, enough for the payload shape.
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=";

async function logicChecks() {
  await check("address rules match serve.py", () => {
    const cases = [
      ["https://evil.com?x=1", null], ["http://8.8.8.8", null], ["http://example.com", null],
      ["https://user:pass@example.com/v1", null], ["https://example.com/v1#frag", null], ["http://172.32.0.1", null],
      ["http://10.1.2.3:8642", "http://10.1.2.3:8642"], ["http://127.0.0.1:8642/", "http://127.0.0.1:8642"],
      ["http://192.168.1.4:8642/p/work", "http://192.168.1.4:8642/p/work"], ["https://example.com/p/work/v1", "https://example.com/p/work"],
      ["https://Example.COM/v1", "https://example.com"], ["https://example.com:443/v1/", "https://example.com"]
    ];
    for (const [raw, expected] of cases) {
      let got = null;
      try { got = Core.normalizeBase(raw); } catch { got = null; }
      assert.equal(got, expected, raw);
    }
    assert.ok(Core.isLoopbackAddress("http://127.0.0.1:8642") && Core.isLoopbackAddress("http://localhost") && !Core.isLoopbackAddress("http://192.168.1.4"));
  });

  // PairingPayloadTests.swift
  await check("pairing round trip keeps only the declared fields", () => {
    const encoded = Core.encodePairing("家中的 Mac", "http://127.0.0.1:8642", "unit-value");
    assert.deepEqual(Core.decodePairing(encoded), { name: "家中的 Mac", url: "http://127.0.0.1:8642", key: "unit-value" });
    assert.ok(encoded.startsWith('{"v":1,"name":'));
    assert.deepEqual(Object.keys(JSON.parse(encoded)).sort(), ["key", "name", "url", "v"]);
  });
  await check("pairing escaping round trip", () => {
    const name = '引号"和\\换\n行';
    const key = 'key-"值';
    const decoded = Core.decodePairing(Core.encodePairing(name, "https://hermes.example.com/v1", key));
    assert.equal(decoded.name, name);
    assert.equal(decoded.key, key);
  });
  await check("pairing names default", () => {
    assert.equal(Core.decodePairing('{"v":1,"url":"http://127.0.0.1:8642","key":"abc"}').name, "扫码连接");
    assert.equal(Core.decodePairing('{"v":1,"name":"  ","url":"http://127.0.0.1:8642","key":"abc"}').name, "扫码连接");
    assert.equal(Core.decodePairing(Core.encodePairing("  ", "http://localhost:8642", "abc")).name, "扫码连接");
  });
  await check("pairing rejects other versions, empty values and extra fields", () => {
    throwsKind(() => Core.decodePairing('{"v":2,"name":"n","url":"http://127.0.0.1:8642","key":"abc"}'), "pairing.unknownVersion");
    throwsKind(() => Core.decodePairing('{"v":0,"url":"http://127.0.0.1:8642","key":"abc"}'), "pairing.unknownVersion");
    throwsKind(() => Core.encodePairing("n", "  ", "abc"), "pairing.emptyURL");
    throwsKind(() => Core.encodePairing("n", "http://127.0.0.1:8642", " \n"), "pairing.emptyKey");
    throwsKind(() => Core.decodePairing('{"v":1,"url":"","key":"abc"}'), "pairing.emptyURL");
    throwsKind(() => Core.decodePairing('{"v":1,"url":"http://127.0.0.1:8642","key":"   "}'), "pairing.emptyKey");
    for (const raw of ['{"v":1,"url":"http://127.0.0.1:8642","key":"abc","token":"no"}', '{"v":1,"url":"http://127.0.0.1:8642"}',
      '{"v":true,"url":"http://127.0.0.1:8642","key":"abc"}', '{"v":"1","url":"http://127.0.0.1:8642","key":"abc"}',
      '{"v":1,"name":null,"url":"http://127.0.0.1:8642","key":"abc"}', "not-json", "[1]",
      JSON.stringify({ v: 1, url: "http://127.0.0.1:8642", key: "k".repeat(8200) })]) {
      throwsKind(() => Core.decodePairing(raw), "pairing.invalid");
    }
  });
  await check("pairing trims, strips a BOM and accepts links", () => {
    const decoded = Core.decodePairing('  {"v":1,"url":" http://127.0.0.1:8642 ","key":" abc "}  ');
    assert.deepEqual([decoded.url, decoded.key], ["http://127.0.0.1:8642", "abc"]);
    assert.equal(Core.decodePairing("\uFEFF" + '{"v":1,"url":"https://h.example","key":"k"}').url, "https://h.example");
    const payload = Core.encodePairing("工作", "https://h.example/v1", "secret");
    assert.equal(Core.pairingText("https://workbench.example/hermes-web/#pair=" + encodeURIComponent(payload)), payload);
    assert.equal(Core.pairingText("https://x.example/?pair=" + encodeURIComponent(payload)), payload);
    assert.equal(Core.pairingText(payload), payload);
    // iOS JSONSerialization escapes slashes; both forms decode the same.
    assert.equal(Core.decodePairing('{"v":1,"name":"n","url":"https:\\/\\/h.example\\/v1","key":"k"}').url, "https://h.example/v1");
  });

  // WorkspaceTests.swift and StreamingTests.swift
  await check("job filters combine query and status", () => {
    const jobs = [
      job({ id: "a", name: "Digest", prompt: "新闻摘要", state: "scheduled", last_status: "delivery_failed" }),
      job({ id: "b", name: "健康检查", state: "paused", enabled: false }),
      job({ id: "c", name: "Done", state: "completed", enabled: false }),
      job({ id: "d", name: "Busy", state: "running" })
    ];
    const ids = (query, filter) => Core.filterJobs(jobs, query, filter).map((item) => item.id);
    assert.deepEqual(ids("新闻", "attention"), ["a"]);
    assert.deepEqual(ids(" digest ", "scheduled"), ["a"]);
    assert.deepEqual(ids("", "paused"), ["b"]);
    assert.deepEqual(ids("", "completed"), ["c"]);
    assert.deepEqual(ids("", "running"), ["d"]);
    assert.equal(Core.jobStatusLabel(jobs[2]), "已完成");
    assert.equal(Core.jobLastStatusLabel(jobs[0]), "结果投递失败");
    assert.deepEqual(Core.jobOverview(jobs), { running: 1, attention: 1, paused: 1 });
    assert.deepEqual(jobs.map(Core.jobStatusTone), ["warning", "neutral", "accent", "info"]);
  });
  await check("job schedules, copies and editor fields", () => {
    const once = job({ id: "x", name: "改名后", schedule: { kind: "once", run_at: "2030-01-01T09:00:00+08:00" }, schedule_display: "once at 2030-01-01 09:00", enabled: false, state: "paused" });
    assert.equal(Core.jobEditableSchedule(once), "2030-01-01T09:00:00+08:00");
    assert.ok(Core.jobIsPaused(once));
    assert.deepEqual(Core.jobCopyDraft(once), { name: "改名后 · 副本", prompt: "", schedule: "" });
    const interval = job({ id: "y", name: "巡检", prompt: "检查服务", schedule: { kind: "interval", minutes: 60 }, schedule_display: "every 1h" });
    assert.equal(Core.jobEditableSchedule(interval), "every 60m");
    assert.equal(Core.jobCopyDraft(job({ id: "z", name: "名".repeat(300) })).name.length, 195 + " · 副本".length);
    const values = { name: " 巡检 · 改名 ", prompt: "检查服务", schedule: "every 60m" };
    assert.deepEqual(Core.jobEditorFields(values, interval, false), { name: "巡检 · 改名" });
    assert.deepEqual(Core.jobEditorFields(values, interval, true), { name: "巡检 · 改名", prompt: "检查服务", schedule: "every 60m" });
    assert.equal(Core.jobEditorCanSave({ name: "巡检", prompt: "检查服务", schedule: "every 60m" }, interval, false), false);
    assert.equal(Core.jobEditorCanSave({ name: "新任务", prompt: "", schedule: "every 1h" }, null, false), false);
    assert.equal(Core.jobEditorCanSave({ name: "新任务", prompt: "做事", schedule: "every 1h" }, null, false), true);
    assert.equal(Core.jobEditorCanSave({ name: "名".repeat(201), prompt: "做事", schedule: "every 1h" }, null, false), false);
    assert.equal(Core.jobEditorCanSave({ name: "巡检", prompt: "", schedule: "every 2h" }, interval, false), true);
  });
  await check("inbox counts and refresh back-off", () => {
    const jobs = [job({ id: "r", state: "running" }), job({ id: "f", state: "scheduled", last_status: "failed" }),
      job({ id: "e", state: "error" }), job({ id: "ok", state: "scheduled", last_status: "ok" })];
    assert.deepEqual(jobs.filter(Core.jobIsAttention).map((item) => item.id), ["r", "f", "e"]);
    assert.equal(Core.pendingCount(2, jobs), 4);
    assert.deepEqual([[30, 0], [30, 1], [30, 3], [60, 3], [120, 9], [0, 2]].map(([s, f]) => Core.refreshDelay(s, f)), [30, 60, 240, 300, 300, 0]);
  });
  await check("timestamps keep unknown zones as text", () => {
    const utc = Core.parseRemoteTimestamp("2026-10-04T01:00:00Z").getTime();
    assert.equal(Core.parseRemoteTimestamp("2026-10-04T09:00:00+08:00").getTime(), utc);
    assert.equal(Core.parseRemoteTimestamp("2026-10-04T01:00:00.123456+00:00").getTime() - utc, 123);
    assert.equal(Core.parseRemoteTimestamp("2026-10-04T09:00:00"), null);
    assert.equal(Core.parseRemoteTimestamp("not a date"), null);
    assert.equal(Core.displayRemoteTimestamp("2026-10-04T09:00:00"), "2026-10-04T09:00:00");
    assert.ok(Core.displayRemoteTimestamp("2026-10-04T01:00:00Z", "Asia/Shanghai").includes("09:00"));
    assert.equal(Core.displayRemoteTimestamp(null), "未提供");
  });

  // ApprovalChoiceTests.swift
  await check("approval paths and choices", () => {
    assert.deepEqual(Core.approvalPaths("python3 ~/src/run.py --out /tmp/out.txt src/main.swift echo hello"), ["~/src/run.py", "/tmp/out.txt", "src/main.swift"]);
    assert.deepEqual(Core.approvalPaths("edit \"~/a/b.swift\", 'src/c.swift'; cat ~/a/b.swift (~/notes.md)"), ["~/a/b.swift", "src/c.swift", "~/notes.md"]);
    assert.deepEqual(Core.approvalPaths("echo hello"), []);
    const approval = (choices, command) => Core.normalizeApproval({ run_id: "run_1", request_id: "req_1", command, choices }, null);
    assert.deepEqual(Core.approvalActions(approval(["once", "deny"], "x")), { once: true, session: false, always: false, deny: true });
    assert.deepEqual(Core.approvalActions(approval(["session", "always", "deny"], "x")), { once: false, session: true, always: true, deny: true });
    assert.deepEqual(Core.approvalActions(approval(["session", "always", "deny"])), { once: false, session: false, always: false, deny: true });
    assert.equal(Core.approvalActions(approval(undefined, "x")).once, true);
    assert.equal(Core.approvalActions(approval(["deny"], "x")).once, false);
    assert.equal(Core.approvalChoiceAllowed(approval(["session", "deny"], "cat ~/notes.txt"), "once"), false);
    assert.equal(Core.approvalChoiceAllowed(approval(["session", "deny"]), "session"), false);
    assert.equal(Core.approvalChoiceAllowed(approval(["session", "deny"], "cat ~/notes.txt"), "session"), true);
    assert.equal(Core.approvalChoiceAllowed(approval([], null), "deny"), true);
    assert.equal(approval(["once"], "x").id, "req_1");
    assert.equal(Core.normalizeApproval({ run_id: "run_9", command: "ls" }).id, "run_9:ls");
    assert.equal(Core.normalizeApproval({ request_id: "r" }, "run_started").runId, "run_started");
  });

  await check("SSE parser handles keepalives, named events and data lines", () => {
    const parser = new Core.SSEParser();
    assert.equal(parser.consume(": keepalive"), null);
    assert.equal(parser.consume(""), null);
    assert.equal(parser.consume("event: hermes.tool.progress"), null);
    assert.equal(parser.consume('data: {"status":"running",'), null);
    assert.equal(parser.consume('data: "tool":"terminal"}'), null);
    assert.deepEqual(parser.consume(""), { event: "hermes.tool.progress", data: '{"status":"running",\n"tool":"terminal"}' });
    assert.equal(parser.consume("data: [DONE]"), null);
    assert.deepEqual(parser.consume(""), { event: null, data: "[DONE]" });
  });
  await check("session stream uses the terminal run status and final answer", () => {
    const decoder = new Core.SessionStreamDecoder("api_123");
    const frames = [
      ["run.started", '{"run_id":"run_1","session_id":"api_123"}'],
      ["assistant.delta", '{"delta":"正在分析"}'],
      ["assistant.commentary", '{"text":"检查项目","already_streamed":false}'],
      ["tool.started", '{"tool_name":"terminal"}'],
      ["approval.request", '{"run_id":"run_1","request_id":"approve_1","command":"example","choices":["once","deny"]}'],
      ["hermes.unknown", "not json"],
      ["assistant.completed", '{"content":"最终回答","session_id":"api_compacted"}'],
      ["run.completed", '{"session_id":"api_compacted","completed":true,"partial":false}']
    ];
    const events = frames.flatMap(([event, data]) => decoder.consume({ event, data }));
    assert.deepEqual(events.map((event) => event.type), ["started", "delta", "commentary", "progress", "approval", "sessionChanged"]);
    assert.equal(events[3].text, "正在运行：terminal");
    assert.equal(events[4].approval.requestId, "approve_1");
    assert.deepEqual(decoder.result, { sessionId: "api_compacted", content: "最终回答" });
  });
  await check("session stream rejects partial runs, missing terminal status and failures", () => {
    const partial = new Core.SessionStreamDecoder("api_123");
    partial.consume({ event: "assistant.completed", data: '{"content":"未完成的答案"}' });
    const error = throwsKind(() => partial.consume({ event: "run.completed", data: '{"completed":false,"partial":true,"turn_exit_reason":"iteration_limit"}' }), "sessionFailed");
    assert.equal(error.reason, "iteration_limit");
    assert.equal(partial.result, null);
    const disconnected = new Core.SessionStreamDecoder("api_123");
    disconnected.consume({ event: "assistant.delta", data: '{"delta":"部分内容"}' });
    throwsKind(() => disconnected.consume({ event: "done", data: "{}" }), "incompleteStream");
    throwsKind(() => new Core.SessionStreamDecoder("s").consume({ event: "run.failed", data: '{"message":"boom"}' }), "sessionFailed");
    throwsKind(() => new Core.SessionStreamDecoder("s").consume({ event: "run.cancelled", data: "{}" }), "sessionCancelled");
    throwsKind(() => new Core.SessionStreamDecoder("s").consume({ event: "run.completed", data: '{"completed":true}' }), "emptyResponse");
    throwsKind(() => new Core.SessionStreamDecoder("s").consume({ event: "assistant.delta", data: "{bad" }), "invalidStream");
  });
  await check("chat payloads match SessionChatPayload", () => {
    assert.deepEqual(Core.sessionChatBody("继续", null), { input: "继续" });
    assert.deepEqual(Core.sessionChatBody("", JPEG), { input: [{ type: "image_url", image_url: { url: JPEG } }] });
    assert.deepEqual(Core.sessionChatBody("看图", JPEG), { input: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: JPEG } }] });
  });
  await check("failed sends restore only what the server did not save", () => {
    const known = new Set(["old"]);
    const row = (id, content) => ({ id, role: "user", content });
    assert.deepEqual(Core.missingParts({ knownIds: known, messages: [], input: "看这张图", hadImage: true, confirmed: false }), { text: true, image: true });
    assert.deepEqual(Core.missingParts({ knownIds: known, messages: [row("new", "看这张图\n[screenshot]")], input: "看这张图", hadImage: true, confirmed: true }), { text: false, image: false });
    assert.deepEqual(Core.missingParts({ knownIds: known, messages: [row("new", "看这张图")], input: "看这张图", hadImage: true, confirmed: true }), { text: false, image: true });
    assert.deepEqual(Core.missingParts({ knownIds: known, messages: [row("old", "旧消息")], input: "看这张图", hadImage: true, confirmed: true }), { text: true, image: true });
  });

  await check("session pages merge back-filled pins and search loaded records", () => {
    const first = [{ id: "recent", title: "Planning", last_active: 200, pinned: false }, { id: "pin", title: "常用", last_active: 10, pinned: true }].map(Core.normalizeSession);
    let sessions = Core.mergeSessions([], first);
    assert.deepEqual(sessions.map((s) => s.id), ["pin", "recent"]);
    assert.deepEqual(Core.filterSessions(sessions, "checklist", false), []);
    const second = [{ id: "pin", title: "常用", pinned: true, last_active: 10 }, { id: "older", title: "工程", source: "CLI", preview: "Release checklist", last_active: 20 }].map(Core.normalizeSession);
    sessions = Core.mergeSessions(sessions, second);
    assert.deepEqual(sessions.map((s) => s.id), ["pin", "recent", "older"]);
    assert.deepEqual(Core.filterSessions(sessions, " release ", false).map((s) => s.id), ["older"]);
    assert.deepEqual(Core.filterSessions(sessions, "cli", false).map((s) => s.id), ["older"]);
    assert.deepEqual(Core.filterSessions(sessions, "", true).map((s) => s.id), ["pin"]);
    const pinned = Core.mergePinned(Core.normalizeSession({ id: "a", title: "常用", preview: "保留摘要", message_count: 8, last_active: 100, pinned: false }), Core.normalizeSession({ id: "a", pinned: true }));
    assert.deepEqual([pinned.pinned, pinned.preview, pinned.messageCount, pinned.lastActive], [true, "保留摘要", 8, 100]);
    assert.equal(Core.normalizeSession({ id: "x" }).pinned, null);
    assert.equal(Core.sessionTitle({ title: "  " }), "未命名会话");
  });
  await check("messages decode ids, parts and inline images", () => {
    const page = Core.normalizeMessagePage({ session_id: "api_123", data: [
      { id: 1, role: "user", content: "看这张 data:image/png;base64,AAAA 图片" },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "已看到" }, { type: "image_url", image_url: { url: "x" } }, { type: "audio" }] },
      { id: 3, role: "system", content: "hidden", display_kind: "hidden" },
      { role: "tool", tool_name: "terminal", content: "" }
    ], pagination: { limit: 4, offset: 0, returned: 4 } });
    assert.deepEqual(page.data.slice(0, 3).map((m) => m.id), ["1", "m2", "3"]);
    assert.equal(page.data[0].content, "看这张 [图片] 图片");
    assert.equal(page.data[1].content, "已看到\n[图片]\n[audio]");
    assert.deepEqual(page.data.map(Core.messageIsVisible), [true, true, false, false]);
    assert.equal(page.hasMore, true);
    assert.equal(page.returned, 4);
    assert.equal(Core.normalizeMessagePage({ data: [{ id: 1, role: "user", content: "a" }] }).hasMore, false);
    assert.equal(Core.roleLabel({ role: "tool", toolName: null }), "工具");
    assert.equal(Core.transcript("标题", [page.data[0]]), "# 标题\n\n## 我\n\n看这张 [图片] 图片");
  });
  await check("search hits keep context around the match", () => {
    const hits = Core.messageSearchHits([{ id: "1", label: "我", text: "x".repeat(60) + "Release" + "y".repeat(100) }, { id: "2", text: "no" }], " release ");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].match, "Release");
    assert.ok(hits[0].before.startsWith("…") && hits[0].after.endsWith("…"));
  });
  await check("markdown escapes HTML and limits links", () => {
    const html = Core.renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://a.example/?q="1") **粗** `<b>`\n\n```js\n</code><script>\n```');
    assert.ok(!/<img|<script|href="javascript/i.test(html), html);
    assert.ok(html.includes('<a href="https://a.example/?q=&quot;1&quot;" target="_blank" rel="noopener noreferrer">ok</a>'));
    assert.ok(html.includes("<strong>粗</strong>") && html.includes("<code>&lt;b&gt;</code>"));
    assert.ok(html.includes('<div class="code-block"><div class="code-head"><span>js</span>') && html.includes("&lt;/code&gt;&lt;script&gt;"));
    assert.ok(Core.renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |").includes("<table>"));
    assert.ok(Core.renderMarkdown("1. 一\n2. 二\n   - 子项").includes("<ol><li>一</li><li>二<ul><li>子项</li></ul></li></ol>"));
  });
  await check("QR codes use level Q and grow with the payload", () => {
    assert.deepEqual([Core.qrEncode("hello").version, Core.qrEncode("hello").size], [1, 21]);
    const payload = Core.encodePairing("家中的 Mac", "https://hermes.example.com/p/work/v1", "sk-" + "x".repeat(48));
    const code = Core.qrEncode(payload);
    assert.ok(code.version >= 7 && code.version <= 10, String(code.version));
    for (const [x, y] of [[0, 0], [code.size - 1, 0], [0, code.size - 1]]) assert.equal(code.modules[y][x], true);
    assert.equal(code.modules[code.size - 8][8], true);
    throwsKind(() => Core.qrEncode("x".repeat(1700)), "qr.tooLong");
    assert.ok(Core.qrSvg("hello").startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"'));
  });
  await check("relay route list matches the workbench relay", () => {
    assert.equal(Core.relayAllows("GET", "/api/sessions?limit=50"), true);
    assert.equal(Core.relayAllows("DELETE", "/api/sessions/api_1"), true);
    assert.equal(Core.relayAllows("PATCH", "/api/sessions/api_1"), false);
    assert.equal(Core.relayAllows("GET", "/api/jobs"), false);
    assert.equal(Core.relayAllows("POST", "/v1/runs/run_1/approval"), true);
    assert.equal(Core.routeLabel("PATCH", "/api/sessions/api_1"), "PATCH /api/sessions/{id}");
    assert.equal(Core.routeLabel("POST", "/api/jobs/a/run"), "POST /api/jobs/{id}/run");
  });
}

async function apiChecks() {
  const client = Core.createClient({ mode: "custom", base: PROXY, headers: { Authorization: "Bearer " + KEY, "X-Hermes-Base": MOCK } });

  await check("models are deduplicated", async () => {
    assert.deepEqual(await client.models(), ["hermes-agent", "work"]);
  });
  await check("sessions page in 50s and merge pinned back-fill", async () => {
    const first = await client.sessions(0);
    assert.equal(first.hasMore, true);
    assert.ok(first.data.some((s) => s.id === "s_old_57" && s.pinned === true));
    const second = await client.sessions(50);
    assert.equal(second.hasMore, false);
    const merged = Core.mergeSessions(Core.mergeSessions([], first.data), second.data);
    assert.equal(merged.length, 62);
    assert.deepEqual(merged.slice(0, 3).map((s) => s.id), ["s_release", "s_api", "s_old_57"]);
  });

  let created;
  await check("create, rename, pin and read a session", async () => {
    created = await client.createSession("协议检查");
    assert.ok(created.id.startsWith("api_"));
    const renamed = await client.renameSession(created.id, "协议检查 · 已改名");
    assert.equal(renamed.title, "协议检查 · 已改名");
    const pinned = await client.setSessionPinned(created.id, true);
    assert.equal(pinned.pinned, true);
    assert.equal(Core.mergePinned(renamed, pinned).title, "协议检查 · 已改名");
    const read = await client.session(created.id);
    assert.equal(read.pinned, true);
  });
  await check("messages load latest first, then older", async () => {
    const latest = await client.messages("s_long", 0);
    assert.equal(latest.data.length, 100);
    assert.equal(latest.hasMore, true);
    assert.equal(latest.returned, 100);
    const older = await client.messages("s_long", latest.returned);
    assert.equal(older.data.length, 30);
    assert.equal(older.hasMore, false);
    assert.ok(Number(older.data[29].id) < Number(latest.data[0].id));
  });

  const events = (list) => (event) => list.push(event);
  await check("text turn streams progress and the final answer", async () => {
    const seen = [];
    const result = await client.streamSession(created.id, "协议检查：你好", null, events(seen));
    assert.equal(result.sessionId, created.id);
    assert.ok(result.content.includes("服务器运行正常"));
    const types = new Set(seen.map((event) => event.type));
    for (const type of ["started", "commentary", "progress", "delta"]) assert.ok(types.has(type), type);
    const page = await client.messages(created.id, 0);
    assert.deepEqual(page.data.map((m) => m.role), ["user", "tool", "assistant"]);
  });
  await check("image turns are saved with a screenshot marker", async () => {
    await client.streamSession(created.id, "看图", JPEG, () => {});
    await client.streamSession(created.id, "", JPEG, () => {});
    const page = await client.messages(created.id, 0);
    const users = page.data.filter((m) => m.role === "user").map((m) => m.content);
    assert.ok(users.includes("看图\n[screenshot]") && users.includes("[screenshot]"), JSON.stringify(users));
  });
  await check("approval requests are answered with the exact run and request", async () => {
    let answered = null;
    const result = await client.streamSession(created.id, "请审批推送", null, (event) => {
      if (event.type === "approval") answered = client.resolveApproval(event.approval, "once");
    });
    await answered;
    assert.ok(result.content.includes("已推送"));
    let denied = null;
    const deniedResult = await client.streamSession(created.id, "approve please", null, (event) => {
      if (event.type === "approval") denied = client.resolveApproval(event.approval, "deny");
    });
    await denied;
    assert.ok(deniedResult.content.includes("跳过"));
  });
  await check("stop ends the run as cancelled", async () => {
    let stopped = null;
    const error = await rejects(client.streamSession(created.id, "慢慢写", null, (event) => {
      if (event.type === "started") stopped = client.stopRun(event.runId);
    }), "sessionCancelled");
    await stopped;
    assert.equal(error.message, "服务端已停止本次回复。");
  });
  await check("failed, partial and dropped runs are reported, never resent", async () => {
    const failed = await rejects(client.streamSession(created.id, "运行失败", null, () => {}), "sessionFailed");
    assert.equal(failed.reason, "tool_error");
    const partial = await rejects(client.streamSession(created.id, "部分完成", null, () => {}), "sessionFailed");
    assert.equal(partial.reason, "iteration_limit");
    await rejects(client.streamSession(created.id, "断开连接", null, () => {}), "incompleteStream");
    await rejects(client.streamSession("missing-session", "你好", null, () => {}), "server");
  });
  await check("compacted sessions continue under the new id", async () => {
    const seen = [];
    const result = await client.streamSession("s_weekly", "压缩后继续", null, events(seen));
    assert.equal(result.sessionId, "s_weekly-c");
    assert.ok(seen.some((event) => event.type === "sessionChanged" && event.id === "s_weekly-c"));
  });
  await check("sessions can be deleted", async () => {
    await client.deleteSession(created.id);
    const error = await rejects(client.session(created.id), "server");
    assert.equal(error.status, 404);
  });

  await check("jobs: list, read, create, edit, pause, resume, run and delete", async () => {
    const jobs = await client.jobs();
    assert.ok(jobs.length >= 5 && jobs.some((item) => item.id === "reading" && Core.jobIsPaused(item)));
    const review = await client.job("review");
    assert.ok(Core.jobNeedsAttention(review));
    const made = await client.createJob({ name: "协议检查任务", schedule: "every 2h", prompt: "检查服务状态" });
    assert.equal(Core.jobEditableSchedule(made), "every 120m");
    const fields = Core.jobEditorFields({ name: "协议检查任务 · 改名", prompt: "检查服务状态", schedule: Core.jobEditableSchedule(made) }, made, false);
    assert.deepEqual(fields, { name: "协议检查任务 · 改名" });
    const edited = await client.updateJob(made.id, fields);
    assert.equal(edited.name, "协议检查任务 · 改名");
    assert.ok(Core.jobIsPaused(await client.setJobPaused(made.id, true)));
    assert.equal(Core.jobIsPaused(await client.setJobPaused(made.id, false)), false);
    await client.runJob(made.id);
    await client.deleteJob(made.id);
    const error = await rejects(client.job(made.id), "server");
    assert.equal(error.status, 404);
  });
  await check("server errors keep the status and body", async () => {
    const error = await rejects(Core.createClient({ mode: "custom", base: PROXY, headers: { Authorization: "Bearer wrong", "X-Hermes-Base": MOCK } }).models(), "server");
    assert.equal(error.status, 401);
    assert.ok(error.message.startsWith("服务错误 401："));
  });
}

async function relayChecks() {
  const withOrigin = (url, options) => fetch(url, Object.assign({}, options, { headers: Object.assign({}, options.headers, { Origin: RELAY_ORIGIN }) }));
  const target = { mode: "default", base: MOCK, headers: { "X-Hermes-Workbench": "1" } };
  const relay = Core.createClient(target, { fetch: withOrigin });

  await check("default connection reads models, sessions and messages through the relay", async () => {
    assert.deepEqual(await relay.models(), ["hermes-agent", "work"]);
    assert.ok((await relay.sessions(0)).data.length > 0);
    assert.ok((await relay.messages("s_api", 0)).data.length > 0);
  });
  await check("routes the relay does not forward are explained", async () => {
    const jobs = await rejects(relay.jobs(), "relayRoute");
    assert.equal(jobs.route, "GET /api/jobs");
    const pin = await rejects(relay.setSessionPinned("s_weekly", true), "relayRoute");
    assert.equal(pin.route, "PATCH /api/sessions/{id}");
  });
  await check("a blocked CORS preflight is told apart from a lost connection", async () => {
    // Browsers report a refused preflight as a TypeError, like a network failure.
    const browserLike = (url, options) => (
      Core.relayAllows(options.method, new URL(url).pathname) ? withOrigin(url, options) : Promise.reject(new TypeError("Failed to fetch")));
    const blocked = await rejects(Core.createClient(target, { fetch: browserLike }).jobs(), "relayRoute");
    assert.ok(blocked.message.includes("GET /api/jobs"));
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    const down = await rejects(Core.createClient(target, { fetch: offline }).jobs(), "network");
    assert.equal(down.message, "无法连接默认 Hermes。请确认 Tailscale 已连接，且 Hermes 地址走直连。");
    const sessions = await rejects(Core.createClient(target, { fetch: offline }).sessions(0), "network");
    assert.equal(sessions.message, down.message);
  });
  await check("known relay gaps are not requested until the relay is opened", async () => {
    const seen = [];
    const counting = (url, options) => { seen.push(options.method + " " + new URL(url).pathname); return withOrigin(url, options); };
    const listOnly = Core.createClient(Object.assign({ relayListOnly: true }, target), { fetch: counting });
    await rejects(listOnly.jobs(), "relayRoute");
    await rejects(listOnly.renameSession("s_weekly", "x"), "relayRoute");
    assert.deepEqual(seen, []);
    assert.ok((await listOnly.sessions(0)).data.length > 0);
    assert.deepEqual(seen, ["GET /api/sessions"]);
  });
}

(async () => {
  await logicChecks();
  if (PROXY && MOCK) {
    await apiChecks();
    await relayChecks();
  }
  for (const failure of failed) console.log("FAIL", failure);
  if (failed.length) {
    console.log(`${failed.length} of ${passed + failed.length} core.js checks failed`);
    process.exit(1);
  }
  console.log(`OK ${passed} core.js checks (iOS rules, API through the proxy, workbench relay)`);
})();
