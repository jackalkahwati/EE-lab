"""One JSON-completion call, two providers — the part-pipeline's LLM plumbing.

The datasheet reader and the contract synthesizer both need "system + user in,
one JSON object out". Historically that was OpenAI-only, which made the whole
sourcing path fall over when that key ran out of quota (it did). This helper
tries OpenAI first (unchanged behavior while the key works) and falls back to
the Anthropic API — the platform's primary, funded key — via the official SDK.

Callers are responsible for validating the returned object (the sourcing path
mechanically verifies pins/bindings downstream); this module only guarantees
"parsed JSON from a frontier model or an exception".
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from digikey import load_env  # .env.local loader
import toolchain  # toolchain path resolver (env-overridable, macOS defaults)

ANTHROPIC_MODEL = "claude-opus-4-8"


def _openai(system, user):
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY not set")
    body = json.dumps({
        "model": os.environ.get("OPENAI_MODEL", "gpt-5.1"),
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions", data=body,
        headers={"Authorization": "Bearer " + key,
                 "content-type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=120).read())
    return json.loads(d["choices"][0]["message"]["content"])


def _anthropic(system, user):
    import anthropic
    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY from env (load_env)
    with client.messages.stream(
        model=ANTHROPIC_MODEL,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        system=system + " Output ONLY one JSON object — no prose, no markdown fences.",
        messages=[{"role": "user", "content": user}],
    ) as stream:
        response = stream.get_final_message()
    if response.stop_reason == "refusal":
        raise RuntimeError("anthropic refused the request")
    text = next((b.text for b in response.content if b.type == "text"), "")
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise RuntimeError("anthropic returned no JSON object: %s" % text[:120])
    return json.loads(m.group(0))


def _claude_cli(system, user):
    """Local Claude Code CLI — the platform's Max-subscription path (same as
    lib/llm.ts claudeCodeCall, honored when USE_CLAUDE_CODE_CLI=1). Burns no
    API credits, which is exactly what saved the pipeline when both metered
    keys ran dry."""
    import subprocess
    bin_path = toolchain.claude_bin()
    prompt = (system + "\nOutput ONLY one JSON object — no prose, no markdown "
              "fences.\n\n" + user)
    # The CLI must auth via the Max subscription. load_env() put the (possibly
    # credit-less) ANTHROPIC_API_KEY into our env — if the child sees it, it
    # takes precedence and the whole point of this fallback is lost.
    env = {k: v for k, v in os.environ.items()
           if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    p = subprocess.run([bin_path, "-p", "--model", "opus", "--output-format", "text"],
                       input=prompt, capture_output=True, text=True, timeout=300,
                       env=env)
    m = re.search(r"\{.*\}", p.stdout, re.DOTALL)
    if not m:
        raise RuntimeError("claude CLI returned no JSON: %s"
                           % (p.stderr or p.stdout)[:120])
    return json.loads(m.group(0))


def complete_json(system, user):
    """system + user -> parsed JSON object. Provider chain: OpenAI ->
    Anthropic API -> local Claude Code CLI (Max subscription, no credits)."""
    load_env()
    errs = []
    # Order is env-configurable (FL_LLM_ORDER, comma list). Default is
    # anthropic-first: the whole pipeline is Claude/Opus-tuned, so the funded
    # metered leg should be tried before OpenAI and before the CLI subscription
    # fallback — no wasted dead-key call per LLM step once Anthropic is funded.
    providers = {"openai": _openai, "anthropic": _anthropic, "claude-cli": _claude_cli}
    order = [p.strip() for p in os.environ.get(
        "FL_LLM_ORDER", "anthropic,openai,claude-cli").split(",") if p.strip() in providers]
    for name in order:
        try:
            return providers[name](system, user)
        except Exception as e:
            errs.append("%s: %s" % (name, str(e)[:100]))
    raise RuntimeError("all model providers failed — " + " | ".join(errs))
