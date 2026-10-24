import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestServer

from providers.akash import akash_adapter
from providers.akash.akash_adapter import AkashAdapter

STATES = {"live": "active", "gone": "closed"}


pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def sidecar(monkeypatch):
    async def status(request):
        dseq = request.match_info["id"]
        if dseq not in STATES:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response({"state": STATES[dseq]})

    app = web.Application()
    app.router.add_get("/akash/deployments/status/{id}", status)
    server = TestServer(app)
    await server.start_server()
    monkeypatch.setattr(akash_adapter, "AKASH_SIDECAR_URL", str(server.make_url("/akash")))
    yield server
    await server.close()


@pytest.mark.parametrize("dseq,expected", [("live", "RUNNING"), ("gone", "STOPPED"), ("missing", "unknown")])
async def test_get_node_status(sidecar, dseq, expected):
    assert await AkashAdapter().get_node_status(provider_instance_id=dseq) == expected


async def test_wait_for_ready_returns_on_active(sidecar):
    assert await AkashAdapter().wait_for_ready(provider_instance_id="live", timeout=5) == "akash-ready"
