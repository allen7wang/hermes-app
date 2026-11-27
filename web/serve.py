#!/usr/bin/env python3
"""Static host and same-origin proxy for the Hermes web client.

The browser only talks to 127.0.0.1. API calls go to /proxy/<path> with
X-Hermes-Base set to the Hermes root. This avoids the API server's opt-in CORS.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
DEFAULT_PORT = 8787
OPENER = build_opener(ProxyHandler({}))


def normalize_base(raw: str) -> str:
    text = (raw or "").strip()
    parts = urlsplit(text)
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("地址不能包含用户名、密码、查询参数或片段")
    scheme = (parts.scheme or "").lower()
    host = (parts.hostname or "").lower()
    if not scheme or not host:
        raise ValueError("请输入完整的服务地址，例如 https://hermes.example.com/v1")
    if not http_allowed(scheme, host):
        raise ValueError("远程服务请使用 HTTPS；HTTP 仅用于局域网地址")
    path = parts.path.strip("/")
    if path == "v1":
        path = ""
    elif path.endswith("/v1"):
        path = path[:-3].rstrip("/")
    port = parts.port
    if (scheme == "https" and port == 443) or (scheme == "http" and port == 80):
        port = None
    netloc = host if port is None else f"{host}:{port}"
    return urlunsplit((scheme, netloc, f"/{path}" if path else "", "", ""))


def http_allowed(scheme: str, host: str) -> bool:
    if scheme == "https":
        return True
    if scheme != "http":
        return False
    if host == "localhost" or host.endswith(".local"):
        return True
    bits = host.split(".")
    if len(bits) != 4 or any(not part.isdigit() for part in bits):
        return False
    nums = [int(part) for part in bits]
    if any(num < 0 or num > 255 for num in nums):
        return False
    first, second = nums[0], nums[1]
    return first in (10, 127) or (first == 192 and second == 168) or (first == 172 and 16 <= second <= 31)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_HEAD(self):
        self._route(head=True)

    def do_GET(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_PATCH(self):
        self._route()

    def do_DELETE(self):
        self._route()

    def _route(self, head=False):
        path = urlsplit(self.path).path
        if path == "/proxy" or path.startswith("/proxy/"):
            self._proxy()
            return
        self._static(head)

    def _static(self, head):
        target = safe_file(urlsplit(self.path).path)
        if target is None:
            self.send_error(404)
            return
        data = b"" if head else open(target, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", content_type(target))
        self.send_header("Content-Length", str(os.path.getsize(target) if head else len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _proxy(self):
        try:
            base = normalize_base(self.headers.get("X-Hermes-Base", ""))
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        split = urlsplit(self.path)
        upstream_path = split.path[len("/proxy"):] or "/"
        if not upstream_path.startswith("/"):
            upstream_path = "/" + upstream_path
        url = base.rstrip("/") + upstream_path
        if split.query:
            url += "?" + split.query
        length = int(self.headers.get("Content-Length", "0") or "0")
        payload = self.rfile.read(length) if length else None
        headers = {}
        for name in ("Authorization", "Content-Type", "Accept"):
            value = self.headers.get(name)
            if value:
                headers[name] = value
        stream = "text/event-stream" in headers.get("Accept", "") or upstream_path.endswith("/stream")
        request = Request(url, data=payload, headers=headers, method=self.command)
        try:
            upstream = OPENER.open(request, timeout=600 if stream else 30)
        except HTTPError as exc:
            upstream = exc
        except URLError as exc:
            self._json(502, {"error": str(exc.reason)})
            return
        raw_status = getattr(upstream, "status", None)
        if raw_status is None:
            raw_status = upstream.getcode()
        if not isinstance(raw_status, int):
            self._json(502, {"error": "上游没有返回状态码"})
            return
        status = raw_status
        if stream and 200 <= status < 300:
            self.close_connection = True
            self.send_response(status)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                while True:
                    chunk = upstream.read(8192)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
            finally:
                upstream.close()
            return
        data = upstream.read()
        self.send_response(status)
        self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))


def safe_file(url_path: str):
    rel = "/index.html" if url_path in ("", "/") else url_path
    root = os.path.realpath(ROOT)
    candidate = os.path.realpath(os.path.join(root, rel.lstrip("/")))
    if candidate != root and not candidate.startswith(root + os.sep):
        return None
    if not os.path.isfile(candidate):
        return None
    return candidate


def content_type(path: str) -> str:
    if path.endswith(".css"):
        return "text/css; charset=utf-8"
    if path.endswith(".js"):
        return "text/javascript; charset=utf-8"
    if path.endswith(".html"):
        return "text/html; charset=utf-8"
    return "application/octet-stream"


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((HOST, port), Handler)
    print(f"Hermes web client: http://{HOST}:{port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
