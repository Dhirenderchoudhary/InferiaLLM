"""Node and worker routes act only on the caller's own nodes and pools.

The gateway proxies /v1/nodes/* and /v1/admin/workers/*, checking a user's
permission but not which nodes it covers. Each route here must refuse a node
or pool outside the caller's org with the same 404 as a missing one, before
doing any work, and the CLI must name its org.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from orchestration.api import admin_workers, nodes as nodes_api
from orchestration.ownership import owns_node, owns_pool_id

OWNER = "org-a"
POOL = "00000000-0000-0000-0000-0000000000aa"
NODE = "11111111-1111-1111-1111-111111111111"


class _Reached(Exception):
    """Raised by any repository call after the ownership lookup."""


class _Inventory:
    """Answers the ownership lookup; any other call means the route acted."""

    def __init__(self):
        self.acted = []

    async def get_node_by_id(self, node_id):
        return {"id": node_id, "pool_id": POOL} if node_id == NODE else None

    def __getattr__(self, name):
        async def _act(*_a, **_kw):
            self.acted.append(name)
            raise _Reached(name)
        return _act


class _Pools:
    def __init__(self, owner_type="organization", owner_id=OWNER):
        self.row = {"id": POOL, "owner_type": owner_type, "owner_id": owner_id,
                    "lifecycle_state": "running"}
        self.acted = []

    async def get(self, pool_id):
        return self.row if str(pool_id) == POOL else None

    def __getattr__(self, name):
        async def _act(*_a, **_kw):
            self.acted.append(name)
            raise _Reached(name)
        return _act


def _allow(_perm):
    return lambda *_a, **_kw: True


@pytest.fixture
def nodes_app():
    inv, pools = _Inventory(), _Pools()
    # Provisioning and events repos record too: some routes start there.
    prov, events = _Inventory(), _Inventory()
    nodes_api.configure(
        inventory_repo=inv, pool_repo=pools, worker_auth=SimpleNamespace(),
        control_plane_external_url="", adapters={}, require_permission=_allow,
        provisioning_repo=prov, node_events_repo=events,
    )
    app = FastAPI()
    app.include_router(nodes_api.router)
    app.state.acted = lambda: inv.acted + prov.acted + events.acted
    return app, inv, pools


@pytest.fixture
def workers_app():
    inv, pools = _Inventory(), _Pools()
    admin_workers.configure(
        worker_auth=SimpleNamespace(), worker_registry=SimpleNamespace(
            get_metrics=lambda _n: [], list_nodes=lambda: []),
        inventory_repo=inv, pool_repo=pools, control_plane_external_url="",
        require_permission=_allow,
    )
    app = FastAPI()
    app.include_router(admin_workers.router)
    return app, inv, pools


def _call(app, method, path, org, body=None):
    headers = {"Authorization": "Bearer t"}
    if org is not None:
        headers["X-Organization-ID"] = org
    client = TestClient(app, raise_server_exceptions=False)
    return client.request(method, path, json=body, headers=headers)


NOT_OWNER = pytest.mark.parametrize(
    "org", ["org-b", "", "None", None], ids=["other-org", "empty", "None", "no-header"],
)

NODE_ROUTES = [
    ("GET", f"/v1/nodes/{NODE}", None),
    ("GET", f"/v1/nodes/{NODE}/log-stream", None),
    ("GET", f"/v1/nodes/{NODE}/deploy-metrics/d1", None),
    ("PATCH", f"/v1/nodes/{NODE}/labels", {"add": {"k": "v"}, "remove": []}),
    ("DELETE", f"/v1/nodes/{NODE}", None),
    ("POST", f"/v1/nodes/{NODE}/provisioning/retry", None),
    ("GET", f"/v1/nodes/{NODE}/depin-details", None),
    ("GET", f"/v1/nodes/{NODE}/provisioning", None),
    ("GET", f"/v1/nodes/{NODE}/provisioning-logs", None),
    ("GET", f"/v1/nodes/{NODE}/ec2-console", None),
]
NODE_IDS = ["get", "log-stream", "deploy-metrics", "labels", "delete", "retry",
            "depin-details", "provisioning", "provisioning-logs", "ec2-console"]


@pytest.mark.parametrize("method, path, body", NODE_ROUTES, ids=NODE_IDS)
@NOT_OWNER
def test_another_orgs_node_is_not_found(nodes_app, method, path, body, org):
    app, inv, _ = nodes_app

    r = _call(app, method, path, org, body)

    # 404, not 403: the same answer as a missing node reveals nothing.
    assert r.status_code == 404, r.text
    assert inv.acted == [], f"the route acted on a node the caller does not own: {inv.acted}"


@pytest.mark.parametrize("method, path, body", NODE_ROUTES, ids=NODE_IDS)
def test_the_owning_org_gets_through(nodes_app, method, path, body):
    app, _, _ = nodes_app

    _call(app, method, path, OWNER, body)

    assert app.state.acted(), "the route never got past the ownership check"


@pytest.mark.parametrize("method, path, body", NODE_ROUTES[:1], ids=NODE_IDS[:1])
def test_a_node_in_a_system_pool_belongs_to_no_org(nodes_app, method, path, body):
    app, inv, pools = nodes_app
    pools.row["owner_type"] = "system"

    assert _call(app, method, path, OWNER, body).status_code == 404
    assert inv.acted == []


def test_xds_status_lists_only_the_callers_nodes(nodes_app):
    app, inv, _ = nodes_app
    rows = [{"id": "n1", "pool_id": POOL}, {"id": "n2", "pool_id": "someone-elses"}]

    async def _rows():
        return rows

    inv.list_xds_nodes = _rows

    assert _call(app, "GET", "/v1/nodes/xds-status", OWNER).json() == {"nodes": [rows[0]]}
    assert _call(app, "GET", "/v1/nodes/xds-status", None).json() == {"nodes": []}


# ---- worker admin ----------------------------------------------------------

WORKER_ROUTES = [
    ("POST", "/v1/admin/workers/tokens", {"pool_id": POOL}),
    ("GET", f"/v1/admin/workers/pool/{POOL}", None),
    ("DELETE", f"/v1/admin/workers/{NODE}", None),
    ("GET", f"/v1/admin/workers/{NODE}/metrics", None),
]
WORKER_IDS = ["mint-token", "list-workers", "revoke", "metrics"]


@pytest.mark.parametrize("method, path, body", WORKER_ROUTES, ids=WORKER_IDS)
@NOT_OWNER
def test_another_orgs_pool_or_worker_is_not_found(workers_app, method, path, body, org):
    app, inv, pools = workers_app

    r = _call(app, method, path, org, body)

    assert r.status_code == 404, r.text
    assert inv.acted == [] and pools.acted == [], (inv.acted, pools.acted)


@pytest.mark.parametrize("method, path, body", WORKER_ROUTES, ids=WORKER_IDS)
def test_the_owning_org_reaches_its_workers(workers_app, method, path, body):
    app, inv, pools = workers_app

    r = _call(app, method, path, OWNER, body)

    assert r.status_code != 404 or inv.acted or pools.acted, r.text


def test_a_token_cannot_be_minted_for_a_system_pool(workers_app):
    app, _, pools = workers_app
    pools.row["owner_type"] = "system"

    r = _call(app, "POST", "/v1/admin/workers/tokens", OWNER, {"pool_id": POOL})

    assert r.status_code == 404
    assert pools.acted == []


# ---- the shared lookups fail closed ----------------------------------------


def _conn(org):
    return SimpleNamespace(headers={} if org is None else {"x-organization-id": org})


class _Broken:
    async def get(self, *_a):
        raise RuntimeError("database down")

    async def get_node_by_id(self, *_a):
        raise RuntimeError("database down")


@pytest.mark.asyncio
async def test_a_failed_lookup_owns_nothing(caplog):
    assert await owns_pool_id(_conn(OWNER), POOL, _Broken()) is False
    assert await owns_node(_conn(OWNER), NODE, _Broken(), _Pools()) is False
    # Logged, so a database outage is not just a run of unexplained 404s.
    assert [r.levelname for r in caplog.records] == ["WARNING", "WARNING"]


@pytest.mark.asyncio
async def test_a_pool_row_without_owner_fields_owns_nothing():
    class _Bare:
        async def get(self, _pool_id):
            return {"id": POOL}

    assert await owns_pool_id(_conn(OWNER), POOL, _Bare()) is False


# ---- the CLI names its org --------------------------------------------------


def _args(**kw):
    base = {"internal_api_key": "k", "orchestration_url": None, "org_id": None}
    base.update(kw)
    return SimpleNamespace(**base)


@pytest.mark.parametrize("module", ["cli.node", "cli.worker"])
def test_the_cli_refuses_to_call_without_an_org(monkeypatch, module):
    import importlib

    mod = importlib.import_module(module)
    monkeypatch.delenv("INFERIA_ORG_ID", raising=False)

    with pytest.raises(SystemExit):
        mod._internal_headers(_args())


@pytest.mark.parametrize("module", ["cli.node", "cli.worker"])
def test_the_cli_sends_the_org_it_is_given(monkeypatch, module):
    import importlib

    mod = importlib.import_module(module)
    monkeypatch.delenv("INFERIA_ORG_ID", raising=False)

    assert mod._internal_headers(_args(org_id=OWNER))["X-Organization-ID"] == OWNER
    monkeypatch.setenv("INFERIA_ORG_ID", "org-env")
    assert mod._internal_headers(_args())["X-Organization-ID"] == "org-env"
