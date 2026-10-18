"""Deployment routes act only on the caller's own deployments.

The gateway checks that a user holds a permission, not which deployments it
covers, and forwards the caller's org. Each route here must refuse another
org's deployment with the same 404 as a missing one, before doing anything.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from orchestration.models.model_deployment import deployment_server as ds

OWNER = "org-a"
DEP = str(uuid4())


class _Reached(Exception):
    """Raised by a stubbed next step: the request got past the ownership check."""


ROUTES = [
    # method, path, json body, attribute that is the route's next step
    ("GET", f"/deployment/status/{DEP}", None, "_auth_channel"),
    ("PATCH", f"/deployment/update/{DEP}", {}, "_auth_channel"),
    ("POST", "/deployment/terminate", {"deployment_id": DEP}, "_build_terminate_deps"),
    ("POST", "/deployment/start", {"deployment_id": DEP}, "_start_deployment_impl"),
    ("DELETE", f"/deployment/delete/{DEP}", None, "asyncpg.connect"),
]


@pytest.fixture
def app(monkeypatch):
    async def _owner(kind, resource_id):
        return OWNER if (kind, resource_id) == ("deployment", DEP) else None

    monkeypatch.setattr(ds, "_lookup_org_id", _owner)
    app = FastAPI()
    app.include_router(ds.router)
    app.state.pool = None
    app.state.worker_controller = None
    return app


def _stub_next_step(monkeypatch, attr):
    reached = []

    def _next(*_a, **_kw):
        reached.append(True)
        raise _Reached()

    owner, _, name = attr.rpartition(".")
    monkeypatch.setattr(getattr(ds, owner) if owner else ds, name, _next)
    return reached


def _call(app, method, path, body, org):
    headers = {"X-Organization-ID": org} if org is not None else {}
    client = TestClient(app, raise_server_exceptions=False)
    return client.request(method, path, json=body, headers=headers)


@pytest.mark.parametrize("method, path, body, attr", ROUTES, ids=[r[1].split("/")[2] for r in ROUTES])
@pytest.mark.parametrize(
    "org", ["org-b", "", "None", None], ids=["other-org", "empty", "None", "no-header"],
)
def test_another_orgs_deployment_is_not_found(app, monkeypatch, method, path, body, attr, org):
    reached = _stub_next_step(monkeypatch, attr)

    r = _call(app, method, path, body, org)

    # 404, not 403: the same answer as a missing deployment reveals nothing.
    assert r.status_code == 404, r.text
    assert reached == [], "the route acted on a deployment the caller does not own"


@pytest.mark.parametrize("method, path, body, attr", ROUTES, ids=[r[1].split("/")[2] for r in ROUTES])
def test_the_owning_org_gets_through(app, monkeypatch, method, path, body, attr):
    reached = _stub_next_step(monkeypatch, attr)

    _call(app, method, path, body, OWNER)

    assert reached == [True]


def test_an_unknown_deployment_is_not_found(app, monkeypatch):
    reached = _stub_next_step(monkeypatch, "_build_terminate_deps")

    r = _call(app, "POST", "/deployment/terminate", {"deployment_id": str(uuid4())}, OWNER)

    assert r.status_code == 404
    assert reached == []


# ---- listing ---------------------------------------------------------------


@pytest.fixture
def listing(monkeypatch):
    asked = []

    class _Stub:
        def __init__(self, _channel):
            pass

        async def ListDeployments(self, req):
            asked.append(req.org_id)
            return SimpleNamespace(deployments=[])

    @asynccontextmanager
    async def _channel():
        yield None

    monkeypatch.setattr(ds, "_auth_channel", _channel)
    monkeypatch.setattr(ds.model_deployment_pb2_grpc, "ModelDeploymentServiceStub", _Stub)
    app = FastAPI()
    app.include_router(ds.router)
    return app, asked


def test_the_list_is_scoped_to_the_callers_org_not_the_query(listing):
    app, asked = listing

    r = _call(app, "GET", "/deployment/deployments?org_id=org-b", None, OWNER)

    assert r.status_code == 200, r.text
    assert asked == [OWNER]


@pytest.mark.parametrize("org", ["", "None", None], ids=["empty", "None", "no-header"])
def test_a_caller_with_no_org_lists_nothing(listing, org):
    app, asked = listing

    r = _call(app, "GET", "/deployment/deployments", None, org)

    assert r.json() == {"deployments": [], "total": 0}
    assert asked == [], "an org-less caller must not reach the unfiltered listing"
