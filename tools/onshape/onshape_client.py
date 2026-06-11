"""Minimal Onshape REST API client.

Auth: Onshape API keys via HTTP Basic Auth (access key = username, secret
key = password). Generate keys at https://dev-portal.onshape.com/keys with
"Read documents" + "Write documents" scopes.

Set environment variables:
    ONSHAPE_ACCESS_KEY
    ONSHAPE_SECRET_KEY
"""

from __future__ import annotations

import os
import re
import time
from typing import Any, Dict, List, Optional

import requests

BASE_URL = os.environ.get("ONSHAPE_BASE_URL", "https://cad.onshape.com")


class OnshapeError(RuntimeError):
    pass


def parse_document_url(url: str) -> Dict[str, str]:
    """Extract documentId and workspaceId from an Onshape document URL like
    https://cad.onshape.com/documents/<did>/w/<wid>/e/<eid>"""
    m = re.search(r"/documents/([0-9a-f]{24})/([wv])/([0-9a-f]{24})", url)
    if not m:
        raise OnshapeError("could not parse document URL: {}".format(url))
    if m.group(2) != "w":
        raise OnshapeError("URL points at a version, not a workspace; open "
                           "the main workspace and copy that URL")
    return {"did": m.group(1), "wid": m.group(3)}


class Client:
    def __init__(self, access_key: Optional[str] = None,
                 secret_key: Optional[str] = None) -> None:
        access_key = access_key or os.environ.get("ONSHAPE_ACCESS_KEY", "")
        secret_key = secret_key or os.environ.get("ONSHAPE_SECRET_KEY", "")
        if not access_key or not secret_key:
            raise OnshapeError(
                "set ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY (create keys "
                "at https://dev-portal.onshape.com/keys)")
        self._auth = (access_key, secret_key)

    def _request(self, method: str, path: str,
                 json: Optional[Dict[str, Any]] = None,
                 params: Optional[Dict[str, Any]] = None) -> Any:
        url = BASE_URL + path
        for attempt in range(4):
            resp = requests.request(
                method, url, json=json, params=params, auth=self._auth,
                headers={"Accept": "application/json;charset=UTF-8; qs=0.09"},
                timeout=60)
            if resp.status_code in (429, 502, 503, 504) and attempt < 3:
                time.sleep(5 * (attempt + 1) if resp.status_code == 429
                           else 2 * (attempt + 1))
                continue
            break
        if resp.status_code >= 400:
            raise OnshapeError("{} {} -> {}: {}".format(
                method, path, resp.status_code, resp.text[:500]))
        if resp.text:
            return resp.json()
        return None

    # -- documents ---------------------------------------------------------

    def list_elements(self, did: str, wid: str) -> List[Dict[str, Any]]:
        return self._request(
            "GET", "/api/v6/documents/d/{}/w/{}/elements".format(did, wid))

    # -- part studios ------------------------------------------------------

    def list_parts(self, did: str, wid: str, eid: str) -> List[Dict[str, Any]]:
        return self._request(
            "GET", "/api/v6/parts/d/{}/w/{}/e/{}".format(did, wid, eid))

    # -- assemblies --------------------------------------------------------

    def create_assembly(self, did: str, wid: str, name: str) -> Dict[str, Any]:
        return self._request(
            "POST", "/api/v6/assemblies/d/{}/w/{}".format(did, wid),
            json={"name": name})

    def insert_instance(self, did: str, wid: str, assembly_eid: str,
                        source_eid: str, part_id: Optional[str] = None,
                        whole_part_studio: bool = False) -> Any:
        body: Dict[str, Any] = {
            "documentId": did,
            "elementId": source_eid,
            "isWholePartStudio": whole_part_studio,
            "isAssembly": False,
        }
        if part_id is not None:
            body["partId"] = part_id
        return self._request(
            "POST",
            "/api/v6/assemblies/d/{}/w/{}/e/{}/instances".format(
                did, wid, assembly_eid),
            json=body)
