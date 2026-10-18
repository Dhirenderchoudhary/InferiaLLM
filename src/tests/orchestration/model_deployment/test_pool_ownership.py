"""Pool routes act only on the caller's own pools, and new pools and
deployments are recorded under the caller's org, never one named in the body.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from orchestration.models.model_deployment import deployment_server as ds
from orchestration.repositories import pool_repo as pool_repo_mod

OWNER = "org-a"
POOL = str(uuid4())


class _Reached(Exception):
    """Raised by a stubbed next step: the request got past the ownership check."""


ROUTES = [
    # method, path, json body, attribute that is the route's next step
    ("GET", f"/deployment/list/pool/{POOL}/inventory", None, "_auth_channel"),
    ("GET", f"/deployment/pool/{POOL}", None, "_auth_channel"),
    ("PATCH", f"/deployment/updatepool/{POOL}", {}, "asyncpg.connect"),
    ("POST", f"/deployment/stoppool/{POOL}", None, "asyncpg.connect"),
    ("POST", f"/deployment/deletepool/{POOL}", None, "_get_pool_lifecycle_state"),
    ("DELETE", f"/deployment/pool/{POOL}", None, "asyncpg.connect"),
    ("GET", f"/deployment/listDeployments/{POOL}", None, "_auth_channel"),
]
IDS = ["inventory", "get", "update", "stop", "deletepool", "delete", "deployments"]


def _app(owner_row):
    async def _owner(pool_id):
        return owner_row if pool_id == POOL else None

    app = FastAPI()
    app.include_router(ds.router)
    app.state.pool = None
    app.state.worker_controller = None
    return app, _owner


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


def _run(monkeypatch, attr, method, path, body, org, owner_row):
    app, owner = _app(owner_row)
    monkeypatch.setattr(ds, "_pool_owner", owner)
    reached = _stub_next_step(monkeypatch, attr)
    return _call(app, method, path, body, org), reached


@pytest.mark.parametrize("method, path, body, attr", ROUTES, ids=IDS)
@pytest.mark.parametrize(
    "org", ["org-b", "", "None", None], ids=["other-org", "empty", "None", "no-header"],
)
def test_another_orgs_pool_is_not_found(monkeypatch, method, path, body, attr, org):
    r, reached = _run(monkeypatch, attr, method, path, body, org,
                      {"owner_type": "organization", "owner_id": OWNER})

    # 404, not 403: the same answer as a missing pool reveals nothing.
    assert r.status_code == 404, r.text
    assert reached == [], "the route acted on a pool the caller does not own"


@pytest.mark.parametrize("method, path, body, attr", ROUTES, ids=IDS)
@pytest.mark.parametrize("owner_type", ["organization", "user"])
def test_the_owning_org_gets_through(monkeypatch, method, path, body, attr, owner_type):
    _, reached = _run(monkeypatch, attr, method, path, body, OWNER,
                      {"owner_type": owner_type, "owner_id": OWNER})

    assert reached == [True]


@pytest.mark.parametrize("method, path, body, attr", ROUTES, ids=IDS)
def test_a_system_pool_belongs_to_no_org(monkeypatch, method, path, body, attr):
    r, reached = _run(monkeypatch, attr, method, path, body, OWNER,
                      {"owner_type": "system", "owner_id": OWNER})

    assert r.status_code == 404
    assert reached == []


# ---- listPools -------------------------------------------------------------


@pytest.fixture
def listing(monkeypatch):
    asked = []

    class _Stub:
        def __init__(self, _channel):
            pass

        async def ListPools(self, req):
            asked.append(req.owner_id)
            return SimpleNamespace(pools=[])

    @asynccontextmanager
    async def _channel():
        yield None

    monkeypatch.setattr(ds, "_auth_channel", _channel)
    monkeypatch.setattr(ds.compute_pool_pb2_grpc, "ComputePoolManagerStub", _Stub)
    app = FastAPI()
    app.include_router(ds.router)
    return app, asked


def test_list_pools_uses_the_callers_org_not_the_path(listing):
    app, asked = listing

    _call(app, "GET", "/deployment/listPools/org-b", None, OWNER)

    assert asked == [OWNER]


@pytest.mark.parametrize("org", ["", "None", None], ids=["empty", "None", "no-header"])
def test_a_caller_with_no_org_lists_no_pools(listing, org):
    app, asked = listing

    r = _call(app, "GET", "/deployment/listPools/org-b", None, org)

    assert r.json() == {"pools": [], "total": 0}
    assert asked == []


# ---- createpool ------------------------------------------------------------


def _pool_body(**over):
    body = {
        "pool_name": "p1", "owner_type": "organization", "owner_id": "org-b",
        "provider": "on_prem", "allowed_gpu_types": ["any"],
        "max_cost_per_hour": 0, "is_dedicated": False,
        "provider_pool_id": "", "scheduling_policy_json": "{}",
    }
    body.update(over)
    return body


@pytest.fixture
def created(monkeypatch):
    stored = []

    class _Repo:
        def __init__(self, _db):
            pass

        async def credential_exists(self, *_a, **_kw):
            return True

        async def create_pool(self, data):
            stored.append(data)
            raise _Reached()

    monkeypatch.setattr(pool_repo_mod, "ComputePoolRepository", _Repo)
    app = FastAPI()
    app.include_router(ds.router)
    app.state.pool = None
    return app, stored


@pytest.mark.parametrize("owner_type", ["organization", "system", "user"])
def test_a_new_pool_is_owned_by_the_caller_whatever_the_body_says(created, owner_type):
    app, stored = created

    _call(app, "POST", "/deployment/createpool", _pool_body(owner_type=owner_type), OWNER)

    assert len(stored) == 1
    assert (stored[0]["owner_type"], stored[0]["owner_id"]) == ("organization", OWNER)


@pytest.mark.parametrize("org", ["", "None", None], ids=["empty", "None", "no-header"])
def test_a_pool_cannot_be_created_without_an_org(created, org):
    app, stored = created

    r = _call(app, "POST", "/deployment/createpool", _pool_body(), org)

    assert r.status_code == 403
    assert stored == []


# ---- deploy ----------------------------------------------------------------


def _deploy_body(**over):
    body = {"model_name": "m", "model_version": "v1", "replicas": 1,
            "gpu_per_replica": 1, "org_id": "org-b"}
    body.update(over)
    return body


@pytest.fixture
def deploying(monkeypatch):
    recorded = []

    async def _external(req, _deploys):
        recorded.append(req.org_id)
        return {"deployment_id": "d1", "state": "RUNNING"}, 201

    async def _no_duplicate(*_a, **_kw):
        return None

    async def _audit(*_a, **_kw):
        return None

    monkeypatch.setattr(ds, "_create_external_deployment", _external)
    monkeypatch.setattr(ds, "_reject_duplicate_deployment", _no_duplicate)
    monkeypatch.setattr(ds, "log_audit_event", _audit)
    app = FastAPI()
    app.include_router(ds.router)
    app.state.pool = None
    app.state.worker_controller = None
    return app, recorded


def test_a_deployment_is_recorded_under_the_callers_org(deploying):
    app, recorded = deploying

    r = _call(app, "POST", "/deployment/deploy",
              _deploy_body(workload_type="external"), OWNER)

    assert r.status_code == 201, r.text
    assert recorded == [OWNER]


@pytest.mark.parametrize("org", ["", "None", None], ids=["empty", "None", "no-header"])
def test_deploying_without_an_org_is_refused(deploying, org):
    app, recorded = deploying

    r = _call(app, "POST", "/deployment/deploy",
              _deploy_body(workload_type="external"), org)

    assert r.status_code == 403
    assert recorded == []


@pytest.mark.parametrize("owner, expect", [
    ("org-b", 404),          # another org's pool: same answer as a missing one
    (OWNER, 409),            # the caller's pool: past the check, refused as terminated
])
def test_deploy_only_targets_the_callers_own_pools(monkeypatch, deploying, owner, expect):
    app, _ = deploying

    class _Repo:
        def __init__(self, _db):
            pass

        async def get(self, _pool_id):
            return {"owner_type": "organization", "owner_id": owner,
                    "lifecycle_state": "terminated"}

    monkeypatch.setattr(pool_repo_mod, "ComputePoolRepository", _Repo)

    r = _call(app, "POST", "/deployment/deploy", _deploy_body(pool_id=POOL), OWNER)

    assert r.status_code == expect, r.text
