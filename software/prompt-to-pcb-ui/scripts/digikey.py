"""DigiKey Product Information API client — resolves an MPN (or keyword) to its
datasheet URL + price + stock. This is the connective tissue for the part
resolver: DigiKey finds the part and its datasheet; datasheet_to_spec reads the
datasheet; resolve_part builds the component.

Auth: 2-legged OAuth (client_credentials) — no user login needed for the Product
Information API. Credentials live in the gitignored .env.local:

    DIGIKEY_CLIENT_ID=...
    DIGIKEY_CLIENT_SECRET=...
    DIGIKEY_BASE=https://sandbox-api.digikey.com    # sandbox (default) or
                                                    # https://api.digikey.com (prod)

Usage:
    digikey.py token                 # verify creds — fetch an access token
    digikey.py part <MPN>            # MPN -> datasheet URL, price, stock
    digikey.py search <keywords>     # keyword search -> top matches
"""
import json
import os
import ssl
import sys
import urllib.parse
import urllib.request

APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _make_ssl_context():
    """KiCad's bundled Python 3.9 has no working CA store, so HTTPS verification
    fails with 'self signed certificate in certificate chain'. Build a context
    from a real CA bundle: SSL_CERT_FILE if set, else certifi, else the macOS
    system bundle, so live DigiKey sourcing works instead of falling back."""
    cafile = os.environ.get("SSL_CERT_FILE")
    if cafile and os.path.exists(cafile):
        return ssl.create_default_context(cafile=cafile)
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    if os.path.exists("/etc/ssl/cert.pem"):
        return ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    return ssl.create_default_context()


_SSL = _make_ssl_context()


def load_env():
    """Load DIGIKEY_*/OPENAI_* from .env.local into os.environ if not already set."""
    p = os.path.join(APP_ROOT, ".env.local")
    if not os.path.exists(p):
        return
    for line in open(p):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def _base():
    return os.environ.get("DIGIKEY_BASE", "https://sandbox-api.digikey.com").rstrip("/")


def get_token():
    cid = os.environ.get("DIGIKEY_CLIENT_ID")
    sec = os.environ.get("DIGIKEY_CLIENT_SECRET")
    if not cid or not sec:
        raise SystemExit("DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET not set in .env.local")
    body = urllib.parse.urlencode({
        "client_id": cid, "client_secret": sec, "grant_type": "client_credentials",
    }).encode()
    req = urllib.request.Request(
        _base() + "/v1/oauth2/token", data=body,
        headers={"content-type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30, context=_SSL) as r:
        return json.loads(r.read())["access_token"]


def _headers(token):
    return {
        "Authorization": "Bearer " + token,
        "X-DIGIKEY-Client-Id": os.environ.get("DIGIKEY_CLIENT_ID", ""),
        "X-DIGIKEY-Locale-Site": "US",
        "X-DIGIKEY-Locale-Language": "en",
        "X-DIGIKEY-Locale-Currency": "USD",
        "content-type": "application/json",
        "accept": "application/json",
    }


def _get(url, token):
    req = urllib.request.Request(url, headers=_headers(token))
    with urllib.request.urlopen(req, timeout=30, context=_SSL) as r:
        return json.loads(r.read())


def _post(url, token, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers=_headers(token))
    with urllib.request.urlopen(req, timeout=30, context=_SSL) as r:
        return json.loads(r.read())


def part_details(mpn, token=None):
    """MPN -> a compact dict {mpn, manufacturer, datasheet, price, stock, desc}."""
    token = token or get_token()
    url = _base() + "/products/v4/search/" + urllib.parse.quote(mpn, safe="") + "/productdetails"
    d = _get(url, token)
    p = d.get("Product", d)
    var = (p.get("ProductVariations") or [{}])[0]
    return {
        "mpn": p.get("ManufacturerProductNumber") or mpn,
        "manufacturer": (p.get("Manufacturer") or {}).get("Name"),
        "datasheet": p.get("DatasheetUrl"),
        "price": var.get("UnitPrice") or p.get("UnitPrice"),
        "stock": p.get("QuantityAvailable"),
        "desc": (p.get("Description") or {}).get("ProductDescription"),
        "package": next((pp.get("ValueText") for pp in (p.get("Parameters") or [])
                         if pp.get("ParameterText") in ("Package / Case", "Supplier Device Package")), None),
    }


def search(keywords, token=None, limit=5):
    token = token or get_token()
    url = _base() + "/products/v4/search/keyword"
    d = _post(url, token, {"Keywords": keywords, "Limit": limit})
    out = []
    for p in d.get("Products", []):
        out.append({
            "mpn": p.get("ManufacturerProductNumber"),
            "manufacturer": (p.get("Manufacturer") or {}).get("Name"),
            "datasheet": p.get("DatasheetUrl"),
            "stock": p.get("QuantityAvailable"),
            "desc": (p.get("Description") or {}).get("ProductDescription"),
        })
    return out


def main():
    load_env()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "token"
    if cmd == "token":
        print("OK token:", get_token()[:24] + "…")
    elif cmd == "part":
        print(json.dumps(part_details(sys.argv[2]), indent=2))
    elif cmd == "search":
        print(json.dumps(search(" ".join(sys.argv[2:])), indent=2))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
