#!/usr/bin/env python3
"""
Insert the FL-1 core board stack STEP into the Motion Check assembly, on an
ISOLATED branch. Flow: branch -> import STEP (async translation) -> insert the
imported Part Studio into the assembly. Write-scoped; the branch is left for
review (main workspace untouched).
"""
import sys, os, base64, json, time, uuid, urllib.request, urllib.error

sys.path.insert(0, "/Users/jackal-kahwati/work-hub/scripts")
import vault  # noqa: E402
AK = vault.get_secret("ONSHAPE_ACCESS_KEY"); SK = vault.get_secret("ONSHAPE_SECRET_KEY")
AUTH = "Basic " + base64.b64encode(f"{AK}:{SK}".encode()).decode()
BASE = "https://cad.onshape.com"
DID = "02ed72e43f8d925e0c7aa678"; WID = "80299bfade6ea16b1cd86a0e"; ASM = "d6767f7eb804454caaa2dc85"

def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Authorization": AUTH, "Accept": "application/json"}
    if body is not None: h["Content-Type"] = "application/json"
    if headers: h.update(headers)
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read(); return r.status, (json.loads(raw) if raw else {})

def make_branch(name):
    _, res = call("POST", f"/api/v6/documents/d/{DID}/workspaces",
                  {"name": name, "isReadOnly": False, "parentId": WID})
    return res["id"]

def import_step(bwid, step_path):
    """Multipart upload + translate a STEP into the document (new Part Studio)."""
    boundary = "----fl" + uuid.uuid4().hex
    fname = os.path.basename(step_path)
    blob = open(step_path, "rb").read()
    fields = {"encodedFilename": fname, "fileContentLength": str(len(blob)),
              "formatName": "STEP", "translate": "true", "storeInDocument": "false",
              "yAxisIsUp": "false", "flattenAssemblies": "false"}
    parts = []
    for k, v in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{fname}\"\r\n"
                 f"Content-Type: application/step\r\n\r\n".encode())
    parts.append(blob); parts.append(f"\r\n--{boundary}--\r\n".encode())
    payload = b"".join(parts)
    req = urllib.request.Request(
        BASE + f"/api/v6/blobelements/d/{DID}/w/{bwid}", data=payload, method="POST",
        headers={"Authorization": AUTH, "Accept": "application/json",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        res = json.loads(r.read())
    tid = res.get("id") or res.get("translationId")
    # poll translation
    for _ in range(60):
        time.sleep(3)
        _, st = call("GET", f"/api/v6/translations/{tid}")
        state = st.get("requestState")
        if state == "DONE":
            return st.get("resultElementIds") or []
        if state and state != "ACTIVE":
            raise RuntimeError(f"import {state}: {json.dumps(st)[:200]}")
    raise RuntimeError("import translation timed out")

def insert_into_assembly(bwid, part_eid):
    code, res = call("POST", f"/api/v6/assemblies/d/{DID}/w/{bwid}/e/{ASM}/instances",
                     {"documentId": DID, "workspaceId": bwid, "elementId": part_eid,
                      "isAssembly": False, "isWholePartStudio": True})
    return code, res

def main():
    step = sys.argv[1] if len(sys.argv) > 1 else "/tmp/fl1-core-stack-slab.step"
    print(f"step: {step} ({os.path.getsize(step)} bytes)")
    bwid = make_branch("fl1-core-stack-placement")
    print("branch:", bwid)
    eids = import_step(bwid, step)
    print("imported elementIds:", eids)
    if eids:
        try:
            code, res = insert_into_assembly(bwid, eids[0])
            print("insert into assembly:", code)
        except Exception as e:
            print("insert step (positioning is manual):", str(e)[:200])
    print("branch URL:", f"{BASE}/documents/{DID}/w/{bwid}/e/{ASM}")

if __name__ == "__main__":
    main()
