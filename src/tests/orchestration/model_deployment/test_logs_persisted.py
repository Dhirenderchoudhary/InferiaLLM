"""GET /deployment/logs/{id}/persisted: the caller's own deployments only.

The route used to pass a single connection to a repository that acquires from
a pool, so it failed on every call. It now uses the app's pool, and answers
another org's deployment with the same 404 as a missing one.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

from orchestration.models.model_deployment import deployment_server

pytestmark = pytest.mark.asyncio


class _Conn:
    def __init__(self, log_row):
        self._log_row = log_row

    async def fetchrow(self, *_a, **_kw):
        return self._log_row


class _Acquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *_a):
        return False


class _Pool:
    """A deployment owned by ``org_id`` (None: no such deployment)."""

    def __init__(self, org_id, log_row=None):
        self._org_id = org_id
        self._log_row = log_row

    async def fetchval(self, *_a, **_kw):
        return self._org_id

    def acquire(self):
        return _Acquire(_Conn(self._log_row))


def _log_row():
    return {
        "id": uuid4(),
        "deployment_id": uuid4(),
        "log_lines": ["pulling image", "container exited 1"],
        "captured_at": datetime(2026, 10, 18, tzinfo=timezone.utc),
        "trigger_event": "FAILED",
    }


async def _get(pool, org="org-1"):
    app = FastAPI()
    app.include_router(deployment_server.router)
    app.state.pool = pool
    headers = {"X-Organization-ID": org} if org is not None else {}
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        return await c.get(f"/deployment/logs/{uuid4()}/persisted", headers=headers)


async def test_the_owning_org_gets_its_persisted_logs():
    r = await _get(_Pool("org-1", _log_row()))
    assert r.status_code == 200
    body = r.json()
    assert body["logs"] == ["pulling image", "container exited 1"]
    assert body["trigger_event"] == "FAILED"


async def test_a_deployment_without_persisted_logs_says_so():
    r = await _get(_Pool("org-1", None))
    assert r.status_code == 200
    assert r.json()["logs"] == []


@pytest.mark.parametrize("org", ["org-2", "", None], ids=["other-org", "empty", "no-header"])
async def test_a_deployment_outside_the_callers_org_is_not_found(org):
    # 404, not 403: the same answer as a missing deployment reveals nothing.
    r = await _get(_Pool("org-1", _log_row()), org)
    assert r.status_code == 404
    assert r.json()["detail"] == "Deployment/Pool not found"


async def test_a_missing_deployment_is_not_found():
    r = await _get(_Pool(None))
    assert r.status_code == 404
