#!/usr/bin/env python3
"""Protocol checks for the Hermes web client. Runs locally without network access.

    python3 web/protocol_test.py                 # all checks
    python3 web/protocol_test.py --mock 18299    # serve the mock Hermes API with demo data

The mock implements the Hermes Agent API routes and the response shapes that the iOS 5.0
client decodes (HermesClient.swift, RemoteModels.swift, SessionStream.swift). The checks:

1. address rules shared with the iOS client (serve.normalize_base);
2. the local proxy in serve.py: methods, query strings, bodies, auth headers and live SSE;
3. web/core.js under Node (when installed): payload rules from the iOS tests, then every API
   call through the proxy against the mock, plus the workbench relay route limits;
4. the exact requests the web client sent, as recorded by the mock.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qsl, unquote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import serve  # noqa: E402

KEY = "mock-key"
OPENER = build_opener(ProxyHandler({}))

URL_CASES = [
    ("https://evil.com?x=1", None),
    ("http://8.8.8.8", None),
    ("http://example.com", None),
    ("https://user:pass@example.com/v1", None),
    ("https://example.com/v1#frag", None),
    ("http://172.32.0.1", None),
    ("http://172.15.0.1", None),
    ("http://10.1.2.3:8642", "http://10.1.2.3:8642"),
    ("http://127.0.0.1:8642/", "http://127.0.0.1:8642"),
    ("http://localhost:8642", "http://localhost:8642"),
    ("http://192.168.1.4:8642/p/work", "http://192.168.1.4:8642/p/work"),
    ("http://172.16.0.1:8642", "http://172.16.0.1:8642"),
    ("https://example.com/v1", "https://example.com"),
    ("https://example.com/v1/", "https://example.com"),
    ("https://example.com/p/work/v1", "https://example.com/p/work"),
    ("https://Example.COM/v1", "https://example.com"),
]

# Routes the workbench relay forwards today (project-private-web/scripts/hermes-relay.mjs).
RELAY_ROUTES = [
    (re.compile(r"^/v1/models$"), ["GET"]),
    (re.compile(r"^/api/sessions$"), ["GET", "POST"]),
    (re.compile(r"^/api/sessions/[\w-]+$"), ["DELETE"]),
    (re.compile(r"^/api/sessions/[\w-]+/messages$"), ["GET"]),
    (re.compile(r"^/api/sessions/[\w-]+/chat/stream$"), ["POST"]),
    (re.compile(r"^/v1/runs/[\w-]+/(approval|stop)$"), ["POST"]),
]


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Run:
    def __init__(self, run_id: str, session_id: str):
        self.id = run_id
        self.session_id = session_id
        self.approval: dict | None = None
        self.choice: str | None = None
        self.resolved = threading.Event()
        self.stopped = threading.Event()


class MockHermes:
    """In-memory Hermes Agent API server. Requests are recorded in self.log."""

    def __init__(self, key: str = KEY, relay_origins=(), relay_routes: str = "current", demo: bool = True, pace: float = 0.05):
        self.key = key
        self.relay_origins = set(relay_origins)
        self.relay_routes = relay_routes
        self.pace = pace
        self.lock = threading.RLock()
        self.log: list[dict] = []
        self.sessions: dict[str, dict] = {}
        self.messages: dict[str, list[dict]] = {}
        self.jobs: dict[str, dict] = {}
        self.runs: dict[str, Run] = {}
        self.ids = itertools.count(1)
        self.message_ids = itertools.count(1000)
        self.server: ThreadingHTTPServer | None = None
        if demo:
            self.seed()

    # ------------------------------------------------------------------ demo data

    def seed(self):
        now = time.time()
        featured = [
            ("s_release", "项目发布复盘", "cli", now - 120, True),
            ("s_weekly", "每周研究简报", "telegram", now - 3600 * 5, False),
            ("s_api", "API 设计评审", "api_server", now - 3600 * 26, True),
            ("s_long", "服务器巡检记录", "cron", now - 3600 * 50, False),
        ]
        for sid, title, source, active, pinned in featured:
            self.sessions[sid] = {"id": sid, "title": title, "source": source, "preview": "", "last_active": active,
                                  "message_count": 0, "pinned": pinned}
            self.messages[sid] = []
        sources = ["cli", "telegram", "api_server", "discord", "cron", None]
        for n in range(1, 59):
            sid = f"s_old_{n:02d}"
            self.sessions[sid] = {"id": sid, "title": f"历史会话 {n:02d}" if n % 9 else "", "source": sources[n % len(sources)],
                                  "preview": f"第 {n} 段较早的讨论。", "last_active": now - 86400 * (3 + n),
                                  "message_count": 2, "pinned": n == 57}
            self.messages[sid] = [self.message("user", f"历史问题 {n}", now - 86400 * (3 + n)),
                                  self.message("assistant", f"历史回答 {n}。", now - 86400 * (3 + n))]
        t = now - 3600
        self.messages["s_release"] = [
            self.message("system", "You are Hermes.", t, display_kind="hidden"),
            self.message("user", "帮我检查新版本的发布准备情况。", t + 10),
            self.message("assistant", "构建和自动化测试已通过，可以继续核对发布说明。", t + 20),
            self.message("tool", "$ git status\nOn branch release/5.0\nnothing to commit, working tree clean", t + 30, tool_name="terminal"),
            self.message("assistant", RELEASE_REPLY, t + 40),
            self.message("user", "顺便推送发布分支。", t + 50),
            self.message("assistant", "推送前需要你的审批，这一轮没有执行。", t + 60, display_kind="failed_turn"),
            self.message("system", "会话已压缩：保留最近的决定和待办。", t + 70),
        ]
        self.messages["s_weekly"] = [
            self.message("user", "总结这周三篇论文的要点。", now - 3600 * 6),
            self.message("assistant", "1. **检索增强**：…\n2. **长上下文**：…\n3. **工具使用**：…", now - 3600 * 5),
        ]
        self.messages["s_api"] = [self.message("user", "评审 /api/jobs 的分页设计。", now - 3600 * 27),
                                  self.message("assistant", "建议保留 `include_disabled` 参数。", now - 3600 * 26)]
        self.messages["s_long"] = []
        for n in range(130):
            role = "user" if n % 2 == 0 else "assistant"
            self.messages["s_long"].append(self.message(role, f"巡检第 {n // 2 + 1} 轮：{'请检查磁盘和服务' if role == 'user' else '一切正常，磁盘占用 61%。'}",
                                                        now - 3600 * 50 + n * 60))
        for sid, rows in self.messages.items():
            self.refresh_summary(sid)
        self.sessions["s_weekly"]["preview"] = "本周三篇论文的要点与下一步。"
        self.sessions["s_release"]["preview"] = "已检查构建结果，正在核对发布内容。"

        soon = datetime.now(timezone.utc) + timedelta(hours=20)
        past = datetime.now(timezone.utc) - timedelta(hours=3)
        jobs = [
            {"id": "weekly", "name": "每周研究简报", "prompt": "整理本周的研究发现与下一步行动。", "state": "running", "enabled": True,
             "schedule_display": "每周一 09:00", "schedule": {"kind": "cron", "expr": "0 9 * * 1"}, "next_run_at": iso(soon),
             "last_run_at": iso(past), "last_status": "running", "last_error": None},
            {"id": "review", "name": "发布验证提醒", "prompt": "检查回归结果和待办。", "state": "scheduled", "enabled": True,
             "schedule_display": "every 1h", "schedule": {"kind": "interval", "minutes": 60}, "next_run_at": iso(soon),
             "last_run_at": iso(past), "last_status": "failed", "last_error": "上次投递失败"},
            {"id": "reading", "name": "晚间阅读", "prompt": "推荐一篇值得读的文章。", "state": "paused", "enabled": False,
             "schedule_display": "every day at 9pm", "schedule": {"kind": "cron", "expr": "0 21 * * *"}, "next_run_at": None,
             "last_run_at": None, "last_status": None, "last_error": None},
            {"id": "launch-note", "name": "发布日提醒", "prompt": "提醒我发布当天检查监控。", "state": "completed", "enabled": False,
             "schedule_display": "once at 2026-11-20 09:00", "schedule": {"kind": "once", "run_at": "2026-11-20T09:00:00+08:00"},
             "next_run_at": None, "last_run_at": "2026-11-20T01:00:03Z", "last_status": "ok", "last_error": None},
            {"id": "backup", "name": "数据库备份", "prompt": "备份数据库并报告大小。", "state": "scheduled", "enabled": True,
             "schedule_display": "0 3 * * *", "schedule": {"kind": "cron", "expr": "0 3 * * *"}, "next_run_at": "2026-11-29T03:00:00",
             "last_run_at": iso(past), "last_status": "ok", "last_error": None},
        ]
        for job in jobs:
            self.jobs[job["id"]] = job

    def message(self, role, content, ts, tool_name=None, display_kind=None):
        row = {"id": next(self.message_ids), "role": role, "content": content, "timestamp": ts}
        if tool_name:
            row["tool_name"] = tool_name
        if display_kind:
            row["display_kind"] = display_kind
        return row

    def refresh_summary(self, sid):
        rows = self.messages.get(sid, [])
        session = self.sessions[sid]
        visible = [row for row in rows if row.get("display_kind") != "hidden"]
        session["message_count"] = len(visible)
        replies = [row for row in visible if row["role"] == "assistant"]
        if replies:
            session["preview"] = re.sub(r"\s+", " ", replies[-1]["content"]).strip()[:80]

    # ------------------------------------------------------------------ server

    def start(self, port: int = 0, host: str = "127.0.0.1") -> "MockHermes":
        mock = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_OPTIONS(self):
                mock.handle(self)

            def do_GET(self):
                mock.handle(self)

            def do_POST(self):
                mock.handle(self)

            def do_PATCH(self):
                mock.handle(self)

            def do_DELETE(self):
                mock.handle(self)

            def log_message(self, format, *args):
                pass

        ThreadingHTTPServer.allow_reuse_address = True
        self.server = ThreadingHTTPServer((host, port), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()

    # ------------------------------------------------------------------ dispatch

    def handle(self, h: BaseHTTPRequestHandler):
        split = urlsplit(h.path)
        path = split.path
        query = parse_qsl(split.query, keep_blank_values=True)
        length = int(h.headers.get("Content-Length") or 0)
        raw = h.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else None
        except ValueError:
            body = {"_raw": raw.decode("utf-8", "replace")}
        relay = h.headers.get("X-Hermes-Workbench") is not None
        entry = {
            "method": h.command, "path": path, "query": query, "body": body,
            "authorization": h.headers.get("Authorization"), "accept": h.headers.get("Accept"),
            "content_type": h.headers.get("Content-Type"), "workbench": h.headers.get("X-Hermes-Workbench"),
            "origin": h.headers.get("Origin"),
        }
        with self.lock:
            self.log.append(entry)
        cors = None
        if h.command == "OPTIONS":
            return self.preflight(h, path)
        if relay:
            origin = h.headers.get("Origin")
            if origin not in self.relay_origins:
                return self.send(h, 403, {"error": "origin_denied"})
            cors = origin
            methods = self.relay_methods(path)
            if not methods:
                return self.send(h, 404, {"error": "route_not_found"}, cors)
            if h.command not in methods:
                return self.send(h, 405, {"error": "method_not_allowed"}, cors)
            if h.headers.get("X-Hermes-Workbench") != "1":
                return self.send(h, 403, {"error": "workbench_required"}, cors)
        elif h.headers.get("Authorization") != f"Bearer {self.key}":
            return self.send(h, 401, {"error": "invalid_api_key"})
        try:
            self.route(h, path, dict(query), body, cors)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def relay_methods(self, path):
        if self.relay_routes == "all":
            return ["GET", "POST", "PATCH", "DELETE"]
        for pattern, methods in RELAY_ROUTES:
            if pattern.match(path):
                return methods
        return None

    def preflight(self, h, path):
        origin = h.headers.get("Origin")
        if origin not in self.relay_origins:
            return self.send(h, 403, {"error": "origin_denied"})
        methods = self.relay_methods(path)
        if not methods:
            return self.send(h, 404, {"error": "route_not_found"}, origin)
        if h.headers.get("Access-Control-Request-Method") not in methods:
            return self.send(h, 405, {"error": "method_not_allowed"}, origin)
        h.send_response(204)
        h.send_header("Access-Control-Allow-Origin", origin)
        h.send_header("Vary", "Origin")
        h.send_header("Access-Control-Allow-Methods", ", ".join(methods))
        h.send_header("Access-Control-Allow-Headers", "content-type, x-hermes-workbench")
        if h.headers.get("Access-Control-Request-Private-Network") == "true":
            h.send_header("Access-Control-Allow-Private-Network", "true")
        h.send_header("Content-Length", "0")
        h.end_headers()

    def send(self, h, status, payload, cors=None):
        data = json.dumps(payload, ensure_ascii=False).encode()
        h.send_response(status)
        h.send_header("Content-Type", "application/json; charset=utf-8")
        h.send_header("Content-Length", str(len(data)))
        h.send_header("Cache-Control", "no-store")
        if cors:
            h.send_header("Access-Control-Allow-Origin", cors)
            h.send_header("Vary", "Origin")
        h.end_headers()
        h.wfile.write(data)

    def route(self, h, path, query, body, cors):
        method = h.command
        send = lambda status, payload: self.send(h, status, payload, cors)  # noqa: E731
        if path == "/v1/models" and method == "GET":
            return send(200, {"object": "list", "data": [{"id": "hermes-agent", "object": "model"}, {"id": ""},
                                                         {"id": "hermes-agent"}, {"id": "work", "object": "model"}]})
        if path == "/api/sessions":
            if method == "GET":
                return send(200, self.list_sessions(query))
            if method == "POST":
                title = (body or {}).get("title")
                if not isinstance(title, str):
                    return send(400, {"error": "invalid_title"})
                sid = f"api_{next(self.ids):05d}"
                with self.lock:
                    self.sessions[sid] = {"id": sid, "title": title.strip() or None, "source": "api_server", "preview": None,
                                          "last_active": time.time(), "message_count": 0, "pinned": False}
                    self.messages[sid] = []
                return send(200, {"object": "hermes.session", "session": self.sessions[sid]})
        m = re.match(r"^/api/sessions/([^/]+)(/messages|/chat/stream)?$", path)
        if m:
            sid = unquote(m.group(1))
            if sid not in self.sessions:
                return send(404, {"error": "session_not_found"})
            if m.group(2) == "/messages" and method == "GET":
                return send(200, self.page_messages(sid, query))
            if m.group(2) == "/chat/stream" and method == "POST":
                return self.stream(h, sid, body or {}, cors)
            if m.group(2) is None:
                return self.session_route(h, sid, method, body, send)
        m = re.match(r"^/v1/runs/([^/]+)/(approval|stop)$", path)
        if m and method == "POST":
            run = self.runs.get(unquote(m.group(1)))
            if not run:
                return send(404, {"error": "run_not_found"})
            if m.group(2) == "stop":
                run.stopped.set()
                run.resolved.set()
                return send(200, {"status": "stopping", "run_id": run.id})
            choice = (body or {}).get("choice")
            if not run.approval or run.resolved.is_set() or (body or {}).get("request_id") != run.approval["request_id"]:
                return send(409, {"error": "approval_not_pending"})
            if choice not in run.approval["choices"] + ["deny"]:
                return send(400, {"error": "invalid_choice"})
            run.choice = choice
            run.resolved.set()
            return send(200, {"resolved": 1})
        if path == "/api/jobs":
            if method == "GET":
                include = query.get("include_disabled") == "true"
                return send(200, {"jobs": [job for job in self.jobs.values() if include or job.get("enabled") is not False]})
            if method == "POST":
                return self.create_job(body or {}, send)
        m = re.match(r"^/api/jobs/([^/]+)(?:/(pause|resume|run))?$", path)
        if m:
            jid = unquote(m.group(1))
            job = self.jobs.get(jid)
            if not job:
                return send(404, {"error": "job_not_found"})
            return self.job_route(jid, job, m.group(2), method, body, send)
        return send(404, {"error": "not_found"})

    # ------------------------------------------------------------------ sessions

    def ordered_sessions(self):
        return sorted(self.sessions.values(), key=lambda s: (-(s.get("last_active") or 0), s["id"]))

    def list_sessions(self, query):
        limit = int(query.get("limit", "50"))
        offset = int(query.get("offset", "0"))
        rows = self.ordered_sessions()
        page = rows[offset:offset + limit]
        if offset == 0:
            # Pinned sessions are back-filled into the first page even when older.
            page += [s for s in rows[limit:] if s.get("pinned")]
        return {"object": "list", "data": page, "limit": limit, "offset": offset, "has_more": offset + limit < len(rows)}

    def page_messages(self, sid, query):
        rows = self.messages[sid]
        limit = int(query.get("limit", "100"))
        offset = int(query.get("offset", "0"))
        end = max(0, len(rows) - offset)
        page = rows[max(0, end - limit):end]
        return {"object": "list", "session_id": sid, "data": page,
                "pagination": {"limit": limit, "offset": offset, "order": query.get("order", "latest"), "returned": len(page)}}

    def session_route(self, h, sid, method, body, send):
        session = self.sessions[sid]
        if method == "GET":
            return send(200, {"object": "hermes.session", "session": session})
        if method == "DELETE":
            with self.lock:
                del self.sessions[sid]
                self.messages.pop(sid, None)
            return send(200, {"object": "hermes.session.deleted", "id": sid, "deleted": True})
        if method == "PATCH":
            fields = body or {}
            if not fields or any(key not in ("title", "pinned") for key in fields):
                return send(400, {"error": "unsupported_session_field"})
            if "pinned" in fields:
                if not isinstance(fields["pinned"], bool):
                    return send(400, {"error": "unsupported_session_field"})
                session["pinned"] = fields["pinned"]
                # Like some servers, answer with the changed metadata only.
                return send(200, {"object": "hermes.session", "session": {"id": sid, "pinned": session["pinned"]}})
            if not isinstance(fields.get("title"), str):
                return send(400, {"error": "invalid_title"})
            session["title"] = fields["title"]
            return send(200, {"object": "hermes.session", "session": session})
        return send(405, {"error": "method_not_allowed"})

    # ------------------------------------------------------------------ chat stream

    def stream(self, h, sid, body, cors):
        raw_input = body.get("input")
        if isinstance(raw_input, list):
            text = "\n".join(part.get("text", "") for part in raw_input if part.get("type") == "text")
            image = any(part.get("type") == "image_url" and str(part.get("image_url", {}).get("url", "")).startswith("data:image/jpeg;base64,")
                        for part in raw_input)
        elif isinstance(raw_input, str):
            text, image = raw_input, False
        else:
            return self.send(h, 400, {"error": "invalid_input"}, cors)
        run = Run(f"run_{next(self.ids):05d}", sid)
        self.runs[run.id] = run
        h.send_response(200)
        h.send_header("Content-Type", "text/event-stream")
        h.send_header("Cache-Control", "no-cache")
        h.send_header("Connection", "close")
        if cors:
            h.send_header("Access-Control-Allow-Origin", cors)
            h.send_header("Vary", "Origin")
        h.end_headers()
        h.close_connection = True

        def emit(event, payload, pause=None):
            h.wfile.write(f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode())
            h.wfile.flush()
            time.sleep(self.pace if pause is None else pause)

        def save_user():
            content = text + ("\n[screenshot]" if image else "") if text else ("[screenshot]" if image else "")
            with self.lock:
                self.messages[sid].append(self.message("user", content, time.time()))
                self.sessions[sid]["last_active"] = time.time()
                self.refresh_summary(sid)

        def finish(reply, tool=None):
            with self.lock:
                if tool:
                    self.messages[sid].append(self.message("tool", tool, time.time(), tool_name="terminal"))
                self.messages[sid].append(self.message("assistant", reply, time.time()))
                self.sessions[sid]["last_active"] = time.time()
                self.refresh_summary(sid)

        h.wfile.write(b": keepalive\n\n")
        emit("run.started", {"run_id": run.id, "session_id": sid})
        if "未保存" in text:
            emit("assistant.delta", {"delta": "连接即将中断"})
            return
        save_user()
        if "断开" in text:
            emit("assistant.delta", {"delta": "正在处理，"})
            return
        if "失败" in text:
            emit("tool.started", {"tool_name": "terminal"})
            emit("tool.failed", {"tool_name": "terminal"})
            emit("run.failed", {"turn_exit_reason": "tool_error", "message": "终端工具返回错误"})
            return
        if "部分" in text:
            emit("assistant.delta", {"delta": "只完成了一部分"})
            emit("assistant.completed", {"content": "只完成了一部分"})
            emit("run.completed", {"completed": False, "partial": True, "turn_exit_reason": "iteration_limit"})
            return
        if "压缩" in text:
            new_sid = sid + "-c"
            with self.lock:
                self.sessions[new_sid] = dict(self.sessions[sid], id=new_sid, last_active=time.time())
                self.messages[new_sid] = list(self.messages[sid])
            sid_out = new_sid
            emit("assistant.commentary", {"text": "上下文较长，已压缩会话", "already_streamed": False})
            emit("assistant.delta", {"delta": "已在压缩后的会话中继续。", "session_id": new_sid})
            with self.lock:
                self.messages[new_sid].append(self.message("assistant", "已在压缩后的会话中继续。", time.time()))
                self.refresh_summary(new_sid)
            emit("assistant.completed", {"content": "已在压缩后的会话中继续。", "session_id": new_sid})
            emit("run.completed", {"session_id": sid_out, "completed": True, "partial": False})
            return
        if "节奏" in text:
            for n in range(4):
                emit("assistant.delta", {"delta": f"第{n + 1}段。"}, pause=0.35)
            emit("assistant.completed", {"content": "第1段。第2段。第3段。第4段。"})
            emit("run.completed", {"session_id": sid, "completed": True, "partial": False})
            finish("第1段。第2段。第3段。第4段。")
            return
        if "慢" in text:
            emit("assistant.commentary", {"text": "正在逐段整理", "already_streamed": False})
            for n in range(60):
                if run.stopped.wait(0.25):
                    emit("run.cancelled", {"session_id": sid, "run_id": run.id})
                    return
                emit("assistant.delta", {"delta": f"第 {n + 1} 段。"}, pause=0)
            finish("".join(f"第 {n + 1} 段。" for n in range(60)))
            emit("assistant.completed", {"content": "".join(f"第 {n + 1} 段。" for n in range(60))})
            emit("run.completed", {"session_id": sid, "completed": True, "partial": False})
            return
        if "审批" in text or "approve" in text.lower():
            emit("assistant.delta", {"delta": "需要推送发布分支，"})
            emit("tool.started", {"tool_name": "terminal"})
            run.approval = {"run_id": run.id, "request_id": f"req_{run.id}", "command": "git push origin release/5.0",
                            "description": "Hermes 请求推送发布分支。", "choices": ["once", "session", "always", "deny"]}
            emit("approval.request", run.approval)
            if not run.resolved.wait(300) or run.stopped.is_set():
                emit("run.cancelled", {"session_id": sid, "run_id": run.id})
                return
            if run.choice == "deny":
                emit("tool.failed", {"tool_name": "terminal"})
                reply = "需要推送发布分支，已按你的决定跳过推送。"
                finish(reply)
            else:
                emit("tool.completed", {"tool_name": "terminal"})
                reply = "需要推送发布分支，已推送 release/5.0。"
                finish(reply, tool="$ git push origin release/5.0\nTo origin\n * [new branch] release/5.0 -> release/5.0")
            emit("assistant.delta", {"delta": reply[len("需要推送发布分支，"):]})
            emit("assistant.completed", {"content": reply, "session_id": sid})
            emit("run.completed", {"session_id": sid, "completed": True, "partial": False})
            return
        emit("assistant.commentary", {"text": "正在查看会话记录", "already_streamed": False})
        emit("tool.started", {"tool_name": "terminal"})
        emit("tool.completed", {"tool_name": "terminal"})
        reply = ("收到图片。" if image else "") + STREAM_REPLY
        for start in range(0, len(reply), 12):
            emit("assistant.delta", {"delta": reply[start:start + 12]})
        finish(reply, tool="$ uptime\n 10:24  up 12 days, load averages: 1.21 1.05 0.98")
        emit("assistant.completed", {"content": reply, "session_id": sid})
        emit("run.completed", {"session_id": sid, "completed": True, "partial": False})
        emit("done", {})

    # ------------------------------------------------------------------ jobs

    def parse_schedule(self, text):
        value = (text or "").strip()
        m = re.fullmatch(r"every (\d+)\s*(m|min|minutes?|h|hours?)", value)
        if m:
            return {"kind": "interval", "minutes": int(m.group(1)) * (60 if m.group(2).startswith("h") else 1)}
        if re.fullmatch(r"[\d*/,-]+( [\d*/,-]+){4}", value):
            return {"kind": "cron", "expr": value}
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?", value):
            return {"kind": "once", "run_at": value}
        if re.fullmatch(r"every day at \d{1,2}(am|pm)", value) or re.fullmatch(r"in \d+[mh]", value):
            return {"kind": "cron", "expr": value}
        return None

    def create_job(self, body, send):
        name, prompt, schedule = body.get("name"), body.get("prompt"), body.get("schedule")
        if not all(isinstance(v, str) and v.strip() for v in (name, prompt, schedule)) or len(name) > 200 or len(prompt) > 5000:
            return send(400, {"error": "invalid_job"})
        parsed = self.parse_schedule(schedule)
        if not parsed:
            return send(400, {"error": "invalid_schedule"})
        jid = f"job{next(self.ids):05d}"
        job = {"id": jid, "name": name, "prompt": prompt, "schedule": parsed, "schedule_display": schedule, "state": "scheduled",
               "enabled": True, "deliver": body.get("deliver"), "next_run_at": iso(datetime.now(timezone.utc) + timedelta(hours=1)),
               "last_run_at": None, "last_status": None, "last_error": None}
        self.jobs[jid] = job
        return send(200, {"job": job})

    def job_route(self, jid, job, action, method, body, send):
        if action is None and method == "GET":
            return send(200, {"job": job})
        if action is None and method == "DELETE":
            del self.jobs[jid]
            return send(200, {"ok": True})
        if action is None and method == "PATCH":
            fields = body or {}
            if not fields or any(key not in ("name", "prompt", "schedule") or not isinstance(value, str) for key, value in fields.items()):
                return send(400, {"error": "unsupported_job_field"})
            if "schedule" in fields:
                parsed = self.parse_schedule(fields["schedule"])
                if not parsed:
                    return send(400, {"error": "invalid_schedule"})
                job["schedule"], job["schedule_display"] = parsed, fields["schedule"]
            for key in ("name", "prompt"):
                if key in fields:
                    job[key] = fields[key]
            return send(200, {"job": job})
        if method != "POST" or action is None:
            return send(405, {"error": "method_not_allowed"})
        if action == "pause":
            job.update(enabled=False, state="paused", next_run_at=None)
        elif action == "resume":
            job.update(enabled=True, state="scheduled", next_run_at=iso(datetime.now(timezone.utc) + timedelta(hours=1)))
        else:
            job.update(enabled=True, state="scheduled")
            threading.Thread(target=self.complete_run, args=(jid,), daemon=True).start()
        return send(200, {"job": job})

    def complete_run(self, jid):
        time.sleep(0.3)
        job = self.jobs.get(jid)
        if job:
            job.update(state="running", last_status="running")
        time.sleep(1.5)
        job = self.jobs.get(jid)
        if job:
            job.update(state="scheduled", last_status="ok", last_error=None, last_run_at=iso(datetime.now(timezone.utc)))


RELEASE_REPLY = """**发布前检查结果**

| 项目 | 状态 |
| --- | :---: |
| 构建 | 通过 |
| 自动化测试 | 510 项通过 |
| 版本号 | 5.0.0 |

还需要确认三件事：

1. 更新记录与版本号
2. 备份兼容性
3. 模拟器安装包校验

可以先运行：

```sh
xcodebuild -scheme Hermes -configuration Release build
```

下一步需要推送发布分支，这一步会请求你的审批。"""

STREAM_REPLY = "服务器运行正常。\n\n- 负载：1.21\n- 已运行：12 天\n\n```text\nload averages: 1.21 1.05 0.98\n```"


# ---------------------------------------------------------------------- checks


class Checks:
    def __init__(self):
        self.count = 0
        self.failures: list[str] = []

    def eq(self, label, got, expected):
        self.count += 1
        if got != expected:
            self.failures.append(f"{label}: got {got!r}, expected {expected!r}")

    def true(self, label, value):
        self.count += 1
        if not value:
            self.failures.append(label)


def check_urls(checks: Checks):
    for raw, expected in URL_CASES:
        try:
            got = serve.normalize_base(raw)
        except ValueError:
            got = None
        checks.eq(f"normalize_base {raw!r}", got, expected)


def proxy_call(proxy, method, path, base, key=KEY, body=None, accept=None, raw_body=None):
    headers = {"X-Hermes-Base": base} if base is not None else {}
    if key is not None:
        headers["Authorization"] = f"Bearer {key}"
    if accept:
        headers["Accept"] = accept
    data = raw_body
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = Request(f"{proxy}/proxy{path}", data=data, method=method, headers=headers)
    try:
        with OPENER.open(request, timeout=15) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def check_proxy(checks: Checks, mock: MockHermes, proxy: str):
    status, data = proxy_call(proxy, "GET", "/v1/models", mock.base)
    checks.eq("proxy forwards GET /v1/models", status, 200)
    checks.true("proxy returns the model list", b"hermes-agent" in data)
    checks.eq("proxy passes the API key", mock.log[-1]["authorization"], f"Bearer {KEY}")
    status, _ = proxy_call(proxy, "GET", "/v1/models", mock.base, key="wrong")
    checks.eq("proxy passes 401 through", status, 401)
    status, _ = proxy_call(proxy, "GET", "/v1/models", None)
    checks.eq("proxy rejects a missing X-Hermes-Base", status, 400)
    status, _ = proxy_call(proxy, "GET", "/v1/models", "http://example.com")
    checks.eq("proxy rejects public HTTP", status, 400)
    status, _ = proxy_call(proxy, "GET", "/api/sessions?limit=50&offset=50&include_children=true", mock.base + "/v1")
    checks.eq("proxy forwards a /v1 base", status, 200)
    checks.eq("proxy keeps the query string", mock.log[-1]["query"], [("limit", "50"), ("offset", "50"), ("include_children", "true")])
    status, _ = proxy_call(proxy, "PATCH", "/api/sessions/s_old_03", mock.base, body={"pinned": True})
    checks.eq("proxy forwards PATCH", (status, mock.log[-1]["method"], mock.log[-1]["body"]), (200, "PATCH", {"pinned": True}))
    status, _ = proxy_call(proxy, "PATCH", "/api/sessions/s_old_03", mock.base, body={"pinned": False})
    status, data = proxy_call(proxy, "DELETE", "/api/jobs/missing", mock.base)
    checks.eq("proxy passes 404 and DELETE through", (status, mock.log[-1]["method"]), (404, "DELETE"))
    status, _ = proxy_call(proxy, "POST", "/api/jobs/reading/resume", mock.base)
    checks.eq("proxy forwards an empty POST", (status, mock.log[-1]["body"]), (200, None))
    proxy_call(proxy, "POST", "/api/jobs/reading/pause", mock.base)

    # SSE must reach the browser as it arrives, not when the stream ends.
    request = Request(f"{proxy}/proxy/api/sessions/s_old_05/chat/stream", data=json.dumps({"input": "节奏测试"}).encode(),
                      method="POST", headers={"X-Hermes-Base": mock.base, "Authorization": f"Bearer {KEY}",
                                              "Content-Type": "application/json", "Accept": "text/event-stream"})
    started = time.time()
    first = None
    text = b""
    with OPENER.open(request, timeout=15) as response:
        content_type = response.headers.get("Content-Type")
        while True:
            chunk = response.read1(65536)
            if not chunk:
                break
            if first is None and b"run.started" in text + chunk:
                first = time.time() - started
            text += chunk
    total = time.time() - started
    checks.eq("proxy streams text/event-stream", content_type, "text/event-stream")
    checks.true(f"proxy delivers SSE incrementally (first event {first}s of {total:.2f}s)", first is not None and first < 0.6 and total > 1.2)
    checks.true("proxy stream ends with run.completed", b"event: run.completed" in text)


def check_node(checks: Checks, mock: MockHermes, proxy: str) -> bool:
    node = shutil.which("node")
    if not node:
        print("SKIP web/core.js checks: node not found")
        return False
    env = dict(os.environ, HERMES_PROXY=f"{proxy}/proxy", HERMES_MOCK=mock.base, HERMES_KEY=KEY,
               HERMES_RELAY_ORIGIN="https://workbench.test")
    result = subprocess.run([node, str(HERE / "protocol_test.js")], env=env, capture_output=True, text=True, timeout=180)
    sys.stdout.write(result.stdout)
    if result.returncode != 0:
        sys.stdout.write(result.stderr)
        checks.failures.append("web/protocol_test.js failed")
    return True


def calls(log, method, pattern):
    regex = re.compile(pattern)
    return [entry for entry in log if entry["method"] == method and regex.fullmatch(entry["path"])
            and entry["workbench"] is None]


def check_recorded_requests(checks: Checks, log: list[dict]):
    """What web/core.js actually sent, compared with the iOS HermesClient requests."""
    custom = [entry for entry in log if entry["workbench"] is None]
    # One request deliberately uses a wrong key to check error reporting.
    checks.true("every custom request carries the API key", custom and all(entry["authorization"] == f"Bearer {KEY}" for entry in custom
                                                                            if entry["authorization"] != "Bearer wrong")
                and sum(entry["authorization"] == "Bearer wrong" for entry in custom) == 1)

    pages = calls(log, "GET", r"/api/sessions")
    checks.true("sessions are listed in pages of 50 with children",
                [("limit", "50"), ("offset", "0"), ("include_children", "true")] in [e["query"] for e in pages]
                and [("limit", "50"), ("offset", "50"), ("include_children", "true")] in [e["query"] for e in pages])
    messages = calls(log, "GET", r"/api/sessions/[^/]+/messages")
    checks.true("messages use the latest-first window of 100",
                [("order", "latest"), ("limit", "100"), ("offset", "0"), ("include_compacted", "true"), ("inline_images", "false")]
                in [e["query"] for e in messages])
    checks.true("older messages continue from the returned count",
                [("order", "latest"), ("limit", "100"), ("offset", "100"), ("include_compacted", "true"), ("inline_images", "false")]
                in [e["query"] for e in messages])
    created = calls(log, "POST", r"/api/sessions")
    checks.true("new sessions send only a title", created and all(set(e["body"]) == {"title"} for e in created))
    patches = [e["body"] for e in calls(log, "PATCH", r"/api/sessions/[^/]+")]
    checks.true("rename sends {title}", {"title": "协议检查 · 已改名"} in patches)
    checks.true("pin sends a JSON boolean", {"pinned": True} in patches and all(
        isinstance(body.get("pinned"), bool) for body in patches if "pinned" in body))
    checks.true("sessions can be deleted", calls(log, "DELETE", r"/api/sessions/[^/]+"))
    checks.true("a session is read by id", calls(log, "GET", r"/api/sessions/[^/]+"))

    streams = calls(log, "POST", r"/api/sessions/[^/]+/chat/stream")
    checks.true("chat streams ask for text/event-stream as JSON", streams and all(
        e["accept"] == "text/event-stream" and (e["content_type"] or "").startswith("application/json") for e in streams))
    text_bodies = [e["body"] for e in streams if isinstance(e["body"].get("input"), str)]
    checks.true("text turns send {input: string}", {"input": "协议检查：你好"} in text_bodies and all(set(b) == {"input"} for b in text_bodies))
    image_bodies = [e["body"]["input"] for e in streams if isinstance(e["body"].get("input"), list)]
    checks.true("image turns send text and image_url parts", any(
        len(parts) == 2 and parts[0] == {"type": "text", "text": "看图"} and parts[1]["type"] == "image_url"
        and set(parts[1]) == {"type", "image_url"} and parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
        for parts in image_bodies))
    checks.true("image-only turns send one image_url part", any(len(parts) == 1 and parts[0]["type"] == "image_url" for parts in image_bodies))

    approvals = calls(log, "POST", r"/v1/runs/[^/]+/approval")
    checks.true("approvals send choice and request_id", approvals and all(
        set(e["body"]) == {"choice", "request_id"} and e["body"]["request_id"].startswith("req_run_") for e in approvals))
    stops = calls(log, "POST", r"/v1/runs/[^/]+/stop")
    checks.true("stop posts without a body", stops and all(e["body"] is None for e in stops))

    jobs = calls(log, "GET", r"/api/jobs")
    checks.true("jobs include disabled ones", jobs and all(e["query"] == [("include_disabled", "true")] for e in jobs))
    new_jobs = [e["body"] for e in calls(log, "POST", r"/api/jobs")]
    checks.true("new jobs send name, schedule, prompt and deliver=local",
                {"name": "协议检查任务", "schedule": "every 2h", "prompt": "检查服务状态", "deliver": "local"} in new_jobs)
    job_patches = [e["body"] for e in calls(log, "PATCH", r"/api/jobs/[^/]+")]
    checks.true("job edits send only changed fields", {"name": "协议检查任务 · 改名"} in job_patches and all(len(body) == 1 for body in job_patches))
    for action in ("pause", "resume", "run"):
        hits = calls(log, "POST", rf"/api/jobs/[^/]+/{action}")
        checks.true(f"job {action} posts without a body", hits and all(e["body"] is None for e in hits))
    checks.true("jobs can be read and deleted", calls(log, "GET", r"/api/jobs/[^/]+") and calls(log, "DELETE", r"/api/jobs/[^/]+"))

    relay = [e for e in log if e["workbench"] is not None]
    checks.true("default connection sends the workbench header without an API key",
                relay and all(e["workbench"] == "1" and e["authorization"] is None for e in relay))


def main_checks() -> int:
    checks = Checks()
    check_urls(checks)
    mock = MockHermes(relay_origins={"https://workbench.test"}).start()
    ThreadingHTTPServer.allow_reuse_address = True
    proxy_server = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
    proxy_server.daemon_threads = True
    serve.Handler.log_message = lambda *args: None
    threading.Thread(target=proxy_server.serve_forever, daemon=True).start()
    proxy = f"http://127.0.0.1:{proxy_server.server_port}"
    try:
        check_proxy(checks, mock, proxy)
        start = len(mock.log)
        if check_node(checks, mock, proxy):
            check_recorded_requests(checks, mock.log[start:])
    finally:
        proxy_server.shutdown()
        mock.stop()
    for failure in checks.failures:
        print("FAIL", failure)
    if checks.failures:
        print(f"{len(checks.failures)} of {checks.count} python checks failed")
        return 1
    print(f"OK {checks.count} python checks ({len(URL_CASES)} url cases, proxy and recorded requests)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mock", type=int, metavar="PORT", help="serve the mock Hermes API with demo data")
    parser.add_argument("--relay-origin", action="append", default=[], metavar="ORIGIN",
                        help="also act as the workbench relay for this page origin (no API key, X-Hermes-Workbench: 1)")
    parser.add_argument("--relay-routes", choices=["current", "all"], default="current",
                        help="relay route list: today's allowlist (default) or every route")
    args = parser.parse_args()
    if args.mock is None:
        return main_checks()
    mock = MockHermes(relay_origins=args.relay_origin, relay_routes=args.relay_routes, pace=0.08).start(args.mock)
    print(f"Mock Hermes API: {mock.base}  key: {KEY}", flush=True)
    if args.relay_origin:
        print(f"Relay mode for {', '.join(args.relay_origin)} ({args.relay_routes} routes)", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        mock.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
