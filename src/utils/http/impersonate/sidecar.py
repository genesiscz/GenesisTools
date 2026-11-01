#!/usr/bin/env python3
"""Chrome-fingerprint HTTP sidecar for ImpersonatedHttpClient (impersonate/client.ts).

Adapted from lukabudik/alza-mcp-community (MIT) - scripts/cf-transport.py.

Sites behind Cloudflare Bot Management answer Bun's and Node's fetch with a 403
challenge page, but accept curl_cffi's Chrome TLS/HTTP2/header fingerprint.

  request line:  {"id":1,"url":"https://...","method":"GET","headers":{...},
                  "body":"<base64>","impersonate":"chrome","timeoutMs":60000,
                  "followRedirects":true}
  response line: {"id":1,"status":200,"url":"https://...","headers":{...},
                  "body":"<base64>","error":null}

One long-lived process with one cookie jar per impersonation profile. Requests
run on a bounded thread pool and are answered in completion order, matched by id.
"""
import base64
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    sys.stderr.write("impersonate-sidecar: curl_cffi is not importable\n")
    sys.exit(1)

MAX_CONCURRENCY = 8
_sessions = {}
_lock = threading.Lock()
_write_lock = threading.Lock()


def get_session(profile):
    with _lock:
        session = _sessions.get(profile)
        if session is None:
            proxy = (os.environ.get("IMPERSONATE_PROXY_URL") or "").strip() or None
            session = cffi_requests.Session(impersonate=profile, proxy=proxy)
            _sessions[profile] = session
        return session


def handle(line):
    rid = None
    try:
        req = json.loads(line)
        rid = req.get("id")
        body = base64.b64decode(req["body"]) if req.get("body") else None
        response = get_session(req.get("impersonate") or "chrome").request(
            (req.get("method") or "GET").upper(),
            req["url"],
            headers=req.get("headers") or {},
            content=body,
            timeout=float(req.get("timeoutMs") or 60000) / 1000.0,
            allow_redirects=req.get("followRedirects") is not False,
        )
        return {
            "id": rid,
            "status": response.status_code,
            "url": str(response.url),
            "headers": {k.lower(): v for k, v in response.headers.items()},
            "body": base64.b64encode(response.content or b"").decode("ascii"),
            "error": None,
        }
    except Exception as error:  # noqa: BLE001 - reported to the caller, the sidecar stays up
        return {"id": rid, "status": 0, "url": "", "headers": {}, "body": "", "error": f"{type(error).__name__}: {error}"}


def respond(line):
    out = json.dumps(handle(line)) + "\n"
    with _write_lock:
        sys.stdout.write(out)
        sys.stdout.flush()


def main():
    pool = ThreadPoolExecutor(max_workers=MAX_CONCURRENCY, thread_name_prefix="impersonate")
    try:
        for line in sys.stdin:
            line = line.strip()
            if line:
                pool.submit(respond, line)
    finally:
        pool.shutdown(wait=True, cancel_futures=True)


if __name__ == "__main__":
    main()
