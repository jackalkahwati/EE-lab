#!/usr/bin/env python3
"""Transparent `claude` shim for the cloud box — the box half of the proxy
hybrid.

The pipeline's LLM legs (scripts/llm_json.py `_claude_cli`, lib/llm.ts
`claudeCodeCall`) shell out to the local `claude` CLI to use Jack's Max
*subscription* instead of burning a metered key. That CLI can't run on a cloud
host. This shim stands in for it: it forwards whatever args + stdin the caller
used to the Mac-side proxy (which runs the real subscription `claude`) over the
existing Cloudflare tunnel, then prints the Mac's stdout and exits its code.

Because it's transparent, no LLM-chain code changes are needed — set
CLAUDE_CLI_PATH to this file and the existing `claude-cli` / `claude-code` legs
just work. And because BYOK requests satisfy the anthropic/openai legs FIRST
(their own metered key), they never reach this shim — only admin/no-BYOK runs
that fall through to the subscription leg do. Non-admins without BYOK are
already stopped by the credit gate before the pipeline runs, so the
subscription only ever serves the admin.

Env:
  FL_MAC_PROXY_URL     e.g. https://mac-llm.firstlight.build/llm  (required)
  FL_MAC_PROXY_SECRET  shared bearer secret matching the Mac proxy (required)
"""
import json
import os
import sys
import urllib.request

URL = os.environ.get("FL_MAC_PROXY_URL")
SECRET = os.environ.get("FL_MAC_PROXY_SECRET")


def fail(msg, code=1):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


if not URL or not SECRET:
    fail("claude-shim: FL_MAC_PROXY_URL / FL_MAC_PROXY_SECRET not set")

payload = json.dumps({
    "args": sys.argv[1:],
    "stdin": sys.stdin.read() if not sys.stdin.isatty() else "",
}).encode()

req = urllib.request.Request(
    URL, data=payload, method="POST",
    headers={"Content-Type": "application/json",
             "Authorization": "Bearer " + SECRET,
             # Cloudflare's edge 403s the default Python-urllib UA as a bot.
             "User-Agent": "firstlight-claude-shim/1"})
try:
    # a hair over the callers' 300s spawn timeout; they kill us first anyway
    with urllib.request.urlopen(req, timeout=305) as resp:
        out = json.loads(resp.read())
except Exception as e:  # network / proxy down → look like a CLI spawn failure
    fail("claude-shim: proxy call failed: %s" % e)

sys.stdout.write(out.get("stdout", ""))
sys.stderr.write(out.get("stderr", ""))
sys.exit(int(out.get("code", 0)))
