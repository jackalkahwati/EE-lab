#!/usr/bin/env python3
"""Vision JSON judgment — images + rubric in, one JSON verdict out.

stdin:  {"system": str, "user": str, "images": [abs paths]}
stdout: {"ok": true, "provider": str, "verdict": {...}}
        {"ok": false, "reason": "unavailable", "errors": [...]}   # honest gate

Providers, in order:
  anthropic  — SDK vision blocks (works when the metered key is alive)
  claude-cli — local Max subscription: `claude -p` with ONLY the Read tool,
               prompt references the image paths; the CLI reads them visually.
               MUST strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the
               child env (a dead key otherwise overrides subscription auth).
"""
import base64
import json
import os
import subprocess
import sys


def _first_json(text):
    i = text.find("{")
    while i != -1:
        depth = 0
        for j in range(i, len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[i:j + 1])
                    except Exception:
                        break
        i = text.find("{", i + 1)
    raise ValueError("no JSON object in model reply")


def _anthropic(system, user, images):
    import anthropic
    client = anthropic.Anthropic()
    content = []
    for p in images:
        ext = os.path.splitext(p)[1].lower().lstrip(".")
        media = "image/jpeg" if ext in ("jpg", "jpeg") else "image/" + (ext or "png")
        content.append({"type": "image", "source": {
            "type": "base64", "media_type": media,
            "data": base64.b64encode(open(p, "rb").read()).decode()}})
    content.append({"type": "text", "text": user})
    out = []
    with client.messages.stream(
            model="claude-opus-4-8", max_tokens=2000, system=system,
            messages=[{"role": "user", "content": content}]) as s:
        for t in s.text_stream:
            out.append(t)
    return _first_json("".join(out))


def _claude_bin():
    """Resolve the claude CLI binary the same way scripts/llm_json.py does —
    a spawned server process often lacks ~/.local/bin on PATH."""
    bin_path = os.environ.get("CLAUDE_CLI_PATH")
    if bin_path:
        return bin_path
    home = os.environ.get("HOME", "")
    for p in (home + "/.local/bin/claude", "/opt/homebrew/bin/claude",
              "/usr/local/bin/claude"):
        if os.path.exists(p):
            return p
    return "claude"  # last resort: PATH lookup


def _claude_cli(system, user, images):
    img_lines = "\n".join("Read this image file: %s" % p for p in images)
    prompt = "%s\n\n%s\n\n%s\n\nReply with ONLY the JSON object." % (system, img_lines, user)
    # The CLI must auth via the Max subscription. If the child sees a (possibly
    # credit-less) ANTHROPIC_API_KEY / AUTH_TOKEN it takes precedence and the
    # whole point of this fallback is lost.
    env = {k: v for k, v in os.environ.items()
           if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    r = subprocess.run(
        [_claude_bin(), "-p", "--model", "opus", "--output-format", "text",
         "--allowedTools", "Read"],
        input=prompt, capture_output=True, text=True, timeout=300, env=env)
    if r.returncode != 0:
        raise RuntimeError("claude cli rc=%d: %s" % (r.returncode, (r.stderr or "")[:200]))
    return _first_json(r.stdout)


def main():
    req = json.load(sys.stdin)
    system, user = req.get("system", ""), req.get("user", "")
    images = [p for p in req.get("images", []) if os.path.exists(p)]
    if not images:
        print(json.dumps({"ok": False, "reason": "unavailable",
                          "errors": ["no readable images"]}))
        return 0
    errs = []
    for name, fn in (("anthropic", _anthropic), ("claude-cli", _claude_cli)):
        try:
            verdict = fn(system, user, images)
            print(json.dumps({"ok": True, "provider": name, "verdict": verdict}))
            return 0
        except Exception as e:
            errs.append("%s: %s" % (name, str(e)[:200]))
    print(json.dumps({"ok": False, "reason": "unavailable", "errors": errs}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
