"""MacroFab Manufacturing API client — turns a composed board into a real PCBA
assembly quote (and, on demand, an order). Auth is a `?apikey=` query param
(from gitignored .env.local). This is the first concrete contract-manufacturer
behind manufacturer.py's abstraction.

Confirmed live:
  POST /api/v2/pcbs                          create a PCB project -> pcb_id
  GET  /api/v2/pcb/{id}                       full PCB record (versions, status)
  GET  /api/v2/pcbs                           list your PCBs
  GET  /api/v3/pcb/{id}/{version}/quote       assembly quote (needs files/BOM)
  POST /api/v3/pcb/{id}/{version}/bom/parts   add BOM line items (JSON)
  POST /api/v3/pcb/{id}/{version}/xyrs        upload placement (XYRS)

  macrofab.py token                 # verify the key
  macrofab.py list                  # list PCBs
  macrofab.py quote <pcb_id> <qty>  # quote an existing PCB
"""
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from digikey import load_env  # reuse the .env.local loader

BASE = "https://api.macrofab.com"


def _key():
    k = os.environ.get("MACROFAB_API_KEY")
    if not k:
        raise SystemExit("MACROFAB_API_KEY not set in .env.local")
    return k


def _api(method, path, body=None, params=None):
    q = dict(params or {})
    q["apikey"] = _key()
    url = "{}{}?{}".format(BASE, path, urllib.parse.urlencode(q))
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"content-type": "application/json", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw[:200]}


# ---- resources --------------------------------------------------------------
def create_pcb(name, description=""):
    s, d = _api("POST", "/api/v2/pcbs", {"pcb": {"name": name, "description": description}})
    if s != 200 or "pcb" not in d:
        raise RuntimeError("create_pcb failed (%s): %s" % (s, d))
    return d["pcb"]["pcb_id"]


def get_pcb(pcb_id):
    s, d = _api("GET", "/api/v2/pcb/%s" % pcb_id)
    return d.get("pcb") if s == 200 else None


def list_pcbs():
    s, d = _api("GET", "/api/v2/pcbs")
    return d if s == 200 else {}


def add_bom_parts(pcb_id, version, parts):
    """parts: list of {record_num, part, origin, value, package, populate, mpn}."""
    return _api("POST", "/api/v3/pcb/%s/%s/bom/parts" % (pcb_id, version), {"parts": parts})


def upload_xyrs(pcb_id, version, components):
    """components: list of {designator,x_loc,y_loc,rotation,board_side,
    component_type,x_size,y_size,value,footprint}."""
    return _api("POST", "/api/v3/pcb/%s/%s/xyrs" % (pcb_id, version), {"xyrs": components})


def get_quote(pcb_id, version=1, quantity=10, **opts):
    params = {"quantity": quantity}
    params.update({k: v for k, v in opts.items() if v is not None})
    return _api("GET", "/api/v3/pcb/%s/%s/quote" % (pcb_id, version), params=params)


def main():
    load_env()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "token"
    if cmd == "token":
        d = list_pcbs()
        print("OK — key valid, %d demo/owned PCB groups" % len(d))
    elif cmd == "list":
        print(json.dumps(list_pcbs(), indent=1)[:1200])
    elif cmd == "quote":
        s, d = get_quote(sys.argv[2], 1, int(sys.argv[3]) if len(sys.argv) > 3 else 10)
        print("quote HTTP", s)
        print(json.dumps(d, indent=1)[:1500])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
