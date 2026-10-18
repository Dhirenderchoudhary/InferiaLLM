"""GET /deployment/logs/{id}/stream must resolve a node during DEPLOYING.

`model_deployments.node_ids` is only populated at RUNNING; during DEPLOYING only
`target_node_id` is set. The stream endpoint must fall back to target_node_id so
the dashboard can stream image-pull / lifecycle logs while the model container is
still being pulled. It should only error when BOTH are null.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

from orchestration.models.model_deployment import (
    deployment_server,
)

pytestmark = pytest.mark.asyncio


def _app():
    app = FastAPI()
    app.include_router(deployment_server.router)
    return app


class _SeqConn:
    """Returns the scripted fetchrow rows in order, then None."""

    def __init__(self, rows):
        self._rows = list(rows)
        self._i = 0

    async def fetchrow(self, *args, **kwargs):
        row = self._rows[self._i] if self._i < len(self._rows) else None
        self._i += 1
        return row

    async def close(self):
        pass


async def _get(path, rows, org="org-1"):
    """GET as the gateway would, forwarding the caller's org when there is one."""
    transport = ASGITransport(app=_app())
    headers = {"X-Organization-ID": org} if org is not None else {}
    with patch.object(
        deployment_server.asyncpg, "connect", AsyncMock(return_value=_SeqConn(rows))
    ):
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            return await c.get(path, headers=headers)


async def _get_stream(dep_id, rows, org="org-1"):
    return await _get(f"/deployment/logs/{dep_id}/stream", rows, org)


async def test_stream_falls_back_to_target_node_id_during_deploying():
    dep_id = str(uuid4())
    target_node = str(uuid4())
    dep_row = {
        "provider": "aws",
        "provider_credential_name": None,
        "node_ids": None,  # not set until RUNNING
        "target_node_id": target_node,
        "org_id": "org-1",
    }
    node_row = {"provider_instance_id": "i-123", "agent_kind": "worker"}

    r = await _get_stream(dep_id, [dep_row, node_row])
    assert r.status_code == 200, r.text
    body = r.json()
    assert "error" not in body, body
    ws_url = body["ws_url"]
    # The ws_url must NOT carry a leading /api — the dashboard's toWsUrl helper
    # prepends /api; a /api prefix here would produce /api/api/... → 404.
    assert ws_url.startswith("/v1/admin/workers/"), (
        f"ws_url must start with /v1/admin/workers/, got: {ws_url!r}"
    )
    assert target_node in ws_url
    assert f"deployment={dep_id}" in ws_url


async def test_stream_errors_only_when_no_node_at_all():
    dep_id = str(uuid4())
    dep_row = {
        "provider": "aws",
        "provider_credential_name": None,
        "node_ids": None,
        "target_node_id": None,  # nothing bound yet
        "org_id": "org-1",
    }

    r = await _get_stream(dep_id, [dep_row])
    assert r.status_code == 200, r.text
    assert r.json() == {"error": "No nodes assigned to this deployment yet."}


def _dep_row(org_id="org-1"):
    return {
        "provider": "aws",
        "provider_credential_name": None,
        "node_ids": None,
        "target_node_id": str(uuid4()),
        "org_id": org_id,
        "pool_id": str(uuid4()),
        "state": "RUNNING",
    }


@pytest.mark.parametrize("path", ["/deployment/logs/{id}/stream", "/deployment/logs/{id}"])
@pytest.mark.parametrize("org", ["org-2", "", None], ids=["other-org", "empty", "no-header"])
async def test_a_deployment_outside_the_callers_org_is_not_found(path, org):
    # 404, not 403: the same answer as a missing deployment reveals nothing.
    r = await _get(path.format(id=uuid4()), [_dep_row("org-1")], org)
    assert r.status_code == 404
    assert r.json()["detail"] == "Deployment/Pool not found"


async def test_the_owning_org_gets_its_stored_logs():
    # Past the org check; nothing has been provisioned yet in this row set.
    r = await _get(f"/deployment/logs/{uuid4()}", [_dep_row("org-1")], "org-1")
    assert r.status_code == 200
    assert r.json() == {"logs": ["Waiting for node provisioning..."]}


@pytest.mark.parametrize("path", ["/deployment/logs/{id}/stream", "/deployment/logs/{id}"])
async def test_a_deployment_with_no_org_belongs_to_nobody(path):
    # The gateway forwards str(None) for a user without an org.
    r = await _get(path.format(id=uuid4()), [_dep_row(None)], "None")
    assert r.status_code == 404
