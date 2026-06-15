"""JLCPCB OpenAPI client — a second contract-manufacturer backend behind
manufacturer.py, for real PCB FABRICATION quotes (JLCPCB's API is fab/stencil,
not full assembly). Auth is an HMAC-SHA1 signed Authorization header built from
accessKey + secretKey + appId (from gitignored .env.local).

Reverse-engineered from the JLCPCB SDK jars + live probing:
  base host : https://api.jlcpcb.com           (overseas/international)
  quote     : POST /overseas/openapi/pcb/calculate   (GetOnlineCalculatePrice)
  header    : Authorization: appid="..",accesskey="..",timestamp="..",nonce="..",signature=".."
  signer    : HMAC-SHA1(secretKey, stringToSign), base64

The one piece that needs the official docs (api.jlcpcb.com/docs/signature, a JS
SPA): the exact `stringToSign` canonical layout. _string_to_sign() holds the
current best guess; finalize it from the docs, then calculate() works.

  jlcpcb.py ping     # hit a simple endpoint to validate the signature
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from digikey import load_env

BASE = os.environ.get("JLCPCB_BASE", "https://api.jlcpcb.com")


def _creds():
    load_env()
    ak, sk, app = (os.environ.get("JLCPCB_ACCESS_KEY"),
                   os.environ.get("JLCPCB_SECRET_KEY"),
                   os.environ.get("JLCPCB_APP_ID"))
    if not (ak and sk):
        raise SystemExit("JLCPCB_ACCESS_KEY / JLCPCB_SECRET_KEY not set in .env.local")
    return ak, sk, app


def _string_to_sign(method, path, body, nonce, timestamp, app_id):
    """Canonical string for the signature. SDK locals show it is built from
    method, canonicalURI, body, appId, nonce, timestamp — BEST GUESS until
    verified against api.jlcpcb.com/docs/signature."""
    return "\n".join([method.upper(), path, body, app_id or "", nonce, timestamp])


def _auth_header(method, path, body):
    ak, sk, app = _creds()
    nonce = uuid.uuid4().hex
    ts = str(int(time.time() * 1000))
    sts = _string_to_sign(method, path, body, nonce, ts, app)
    sig = base64.b64encode(hmac.new(sk.encode(), sts.encode(), hashlib.sha1).digest()).decode()
    return ('appid="%s",accesskey="%s",timestamp="%s",nonce="%s",signature="%s"'
            % (app, ak, ts, nonce, sig))


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
