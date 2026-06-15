"""JLCPCB OpenAPI client — a second contract-manufacturer backend behind
manufacturer.py, for real PCB FABRICATION quotes (JLCPCB's API is fab/stencil,
not full assembly). Auth is an HMAC-SHA1 signed Authorization header built from
accessKey + secretKey + appId (from gitignored .env.local).

Signing CONFIRMED working live (per the JLCPCB API docs):
  base host : https://open.jlcpcb.com
  quote     : POST /overseas/openapi/pcb/calculate   (GetOnlineCalculatePrice)
  header    : Authorization: JOP appid="..",accesskey="..",nonce="..",timestamp="..",signature=".."
  stringToSign: METHOD\nPATH\nUNIX_SECONDS\nNONCE_32\nBODY\n   (trailing \n)
  signer    : HMAC-SHA256(secretKey, stringToSign), base64
A valid signature returns 200/business codes; a bad one returns 401 "signature
verify failed" (verified by tampering the secret).

Remaining: the "EE lab" app needs PCB-API permission granted in the JLCPCB API
console (calculate currently returns 403 "API insufficient permissions").

  jlcpcb.py ping     # hit a simple endpoint to validate the signature
"""
import base64
import hashlib
import hmac
import json
import os
import random
import string
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from digikey import load_env

BASE = os.environ.get("JLCPCB_BASE", "https://open.jlcpcb.com")


def _creds():
    load_env()
    ak, sk, app = (os.environ.get("JLCPCB_ACCESS_KEY"),
                   os.environ.get("JLCPCB_SECRET_KEY"),
                   os.environ.get("JLCPCB_APP_ID"))
    if not (ak and sk):
        raise SystemExit("JLCPCB_ACCESS_KEY / JLCPCB_SECRET_KEY not set in .env.local")
    return ak, sk, app


def _nonce():
    return "".join(random.choices(string.ascii_letters + string.digits, k=32))


def _string_to_sign(method, path, timestamp, nonce, body):
    """Per JLCPCB docs: five lines, each terminated by \\n (including the last):
    METHOD, request path (with query), unix-seconds timestamp, 32-char nonce,
    raw body (empty for GET)."""
    return "%s\n%s\n%d\n%s\n%s\n" % (method.upper(), path, timestamp, nonce, body)


def _auth_header(method, path, body):
    ak, sk, app = _creds()
    nonce = _nonce()
    ts = int(time.time())  # unix SECONDS
    sts = _string_to_sign(method, path, ts, nonce, body)
    sig = base64.b64encode(hmac.new(sk.encode(), sts.encode(), hashlib.sha256).digest()).decode()
    # scheme prefix "JOP "; fixed field order; entire value on one line
    return ('JOP appid="%s",accesskey="%s",nonce="%s",timestamp="%d",signature="%s"'
            % (app, ak, nonce, ts, sig))


def call(path, body=None, method="POST"):
    bj = json.dumps(body or {})
    req = urllib.request.Request(
        BASE + path, data=bj.encode(), method=method,
        headers={"Content-Type": "application/json",
                 "Authorization": _auth_header(method, path, bj)})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw[:200]}


def calculate(pcb_param, quantity, file_key=None):
    """Fab price for a board. pcb_param = JLCPCB PcbParam (layers, size, etc.)."""
    return call("/overseas/openapi/pcb/calculate", {
        "OrderType": "PCB", "BatchNum": quantity,
        "FileKey": file_key, "PcbParam": pcb_param})


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "ping"
    if cmd == "ping":
        s, d = call("/overseas/openapi/pcb/getSteelPriceConfig", {})
        print("HTTP", s, json.dumps(d)[:300])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
