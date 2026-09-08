"""Regression tests for the prefs CRUD factory (keybindings/layouts/workspaces).

The original bug: three copy-pasted route triplets, two of which had DELETE
decorators with no function body underneath — `DELETE /api/keybindings/{id}`
was silently stacked onto `layouts_get` and returned a LIST of layouts while
deleting nothing. These tests pin the shape of every verb on every resource.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from openterm.api.app import create_app

RESOURCES = {
    "/keybindings": "bindings",
    "/layouts": "config",
    "/workspaces": "config",
}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OT_CONFIG_PATH", str(tmp_path / "cfg" / "config.json"))
    app = create_app(db_path=tmp_path / "t.db", with_providers=False)
    with TestClient(app) as c:
        yield c


@pytest.mark.parametrize("path,value_field", RESOURCES.items())
def test_prefs_roundtrip(client, path, value_field):
    body = {"name": "Default", value_field: "{\"a\": 1}"}
    created = client.post(f"/api{path}", json=body)
    assert created.status_code == 200, created.text
    oid = created.json()["id"]
    assert created.json()[value_field] == "{\"a\": 1}"

    listed = client.get(f"/api{path}").json()
    assert isinstance(listed, list) and len(listed) == 1
    assert listed[0]["name"] == "Default"

    updated = client.put(f"/api{path}/{oid}",
                         json={"name": "Renamed", value_field: "{}"})
    assert updated.status_code == 200, updated.text
    assert client.get(f"/api{path}").json()[0]["name"] == "Renamed"


@pytest.mark.parametrize("path,value_field", RESOURCES.items())
def test_prefs_delete_exists_and_works(client, path, value_field):
    """The orphan-decorator regression: DELETE must answer {removed: bool}
    for THIS resource, never a foreign list."""
    oid = client.post(f"/api{path}",
                      json={"name": "Doomed", value_field: "x"}).json()["id"]

    r = client.delete(f"/api{path}/{oid}")
    assert r.status_code == 200
    assert isinstance(r.json(), dict), "DELETE returned a list — orphan decorator is back"
    assert r.json() == {"removed": True}
    assert client.get(f"/api{path}").json() == []

    again = client.delete(f"/api{path}/{oid}")
    assert again.json() == {"removed": False}


@pytest.mark.parametrize("path,value_field", RESOURCES.items())
def test_prefs_put_unknown_is_404_and_empty_value_rejected(client, path, value_field):
    assert client.put(f"/api{path}/999",
                      json={"name": "ghost", value_field: "x"}).status_code == 404
    empty = client.post(f"/api{path}", json={"name": "x", value_field: "   "})
    assert empty.status_code == 400
