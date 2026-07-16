#!/usr/bin/env python3
"""Metered LLM health check — is a paid provider actually live?

Tests each configured key with a minimal real call and classifies the result
as ALIVE, out-of-credit, bad-key, or unset. The pipeline falls back to the
local Claude CLI (Max subscription) when no metered provider is live, which
does NOT work on a cloud host — so this is the go/no-go for moving off the Mac.

Exit 0 if at least one metered provider is ALIVE, else 1.

  python3 scripts/llm_health.py
"""
import json
import sys
import urllib.error
import urllib.request

from digikey import load_env


def _probe(url, headers, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return "ALIVE", r.status, ""
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")[:200]
        if e.code in (401, 403):
            return "BAD-KEY", e.code, msg
        if e.code == 429 or "credit" in msg.lower() or "quota" in msg.lower():
            return "OUT-OF-CREDIT", e.code, msg
        return "ERROR", e.code, msg
    except Exception as e:
        return "ERROR", 0, str(e)[:200]


def main():
    import os
    load_env()
    alive = False
    ak = os.environ.get("ANTHROPIC_API_KEY")
    ok = os.environ.get("OPENAI_API_KEY")

    if ak:
        st, code, msg = _probe(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": ak, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            {"model": "claude-opus-4-8", "max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]})
        alive = alive or st == "ALIVE"
        print("anthropic : %-13s %s" % (st, ("(%s) %s" % (code, msg[:80])) if st != "ALIVE" else ""))
    else:
        print("anthropic : UNSET")

    if ok:
        st, code, msg = _probe(
            "https://api.openai.com/v1/chat/completions",
            {"authorization": "Bearer " + ok, "content-type": "application/json"},
            {"model": "gpt-4o-mini", "max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]})
        alive = alive or st == "ALIVE"
        print("openai    : %-13s %s" % (st, ("(%s) %s" % (code, msg[:80])) if st != "ALIVE" else ""))
    else:
        print("openai    : UNSET")

    print("\nmetered LLM: %s" % ("LIVE — cloud-ready" if alive else
                                 "NOT LIVE — pipeline runs on the local Claude CLI subscription only"))
    return 0 if alive else 1


if __name__ == "__main__":
    sys.exit(main())
