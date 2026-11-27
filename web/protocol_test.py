#!/usr/bin/env python3
"""URL normalization checks. No network."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import serve

CASES = [
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


def main() -> int:
    failed = 0
    for raw, expected in CASES:
        try:
            got = serve.normalize_base(raw)
        except ValueError:
            got = None
        if got != expected:
            failed += 1
            print(f"FAIL {raw!r} -> {got!r}, expected {expected!r}")
    if failed:
        print(f"{failed} failed")
        return 1
    print(f"OK {len(CASES)} url cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
