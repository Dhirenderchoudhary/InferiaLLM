import uuid
from contextlib import asynccontextmanager
from unittest.mock import MagicMock, patch

import httpx
import pytest
from fastapi import HTTPException

from common.circuit_breaker import CircuitState, circuit_breaker_registry
from inference.core.service import GatewayService

URL = "https://api.example.com"


@asynccontextmanager
async def _no_limit(key):
    yield


def _upstream(statuses):
    """Serve the given status codes in order; the last one repeats."""
    statuses = list(statuses)

    async def body():
        yield b'data: {"ok": true}\n\n'

    def handler(request):
        code = statuses.pop(0) if len(statuses) > 1 else statuses[0]
        # A generator body stays unread, like a real network response.
        return httpx.Response(code, content=body())

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def service():
    adapter = MagicMock()
    adapter.get_chat_path.return_value = "/v1/chat/completions"
    adapter.transform_request.side_effect = lambda x: x
    adapter.transform_response.side_effect = lambda x: x
    with patch("inference.core.service.get_adapter", return_value=adapter), \
         patch("inference.core.service.http_client") as hc, \
         patch("inference.core.service.upstream_concurrency_limiter") as lim, \
         patch("inference.core.service.settings") as s:
        lim.limit = _no_limit
        s.upstream_allowed_internal_hosts = ""
        s.upstream_max_response_bytes = 52_428_800
        yield hc


async def _stream(key):
    return b"".join([c async for c in GatewayService.stream_upstream(URL, {"model": "m"}, {}, concurrency_key=key)])


def _breaker(key):
    return circuit_breaker_registry.get_or_create(f"upstream:{key}")


@pytest.mark.asyncio
async def test_stream_client_errors_do_not_open_breaker(service):
    key = f"k-{uuid.uuid4()}"
    service.get_client.return_value = _upstream([400])
    for _ in range(6):
        body = await _stream(key)
        assert b"circuit breaker" not in body.lower()
        assert b"error" in body.lower()
    assert _breaker(key).state == CircuitState.CLOSED


@pytest.mark.asyncio
async def test_stream_success_resets_failure_count(service):
    key = f"k-{uuid.uuid4()}"
    service.get_client.return_value = _upstream([500, 500, 500, 500, 200, 500, 500, 500, 500])
    for _ in range(9):
        await _stream(key)
    assert _breaker(key).state == CircuitState.CLOSED


@pytest.mark.asyncio
async def test_stream_success_closes_half_open_breaker(service):
    key = f"k-{uuid.uuid4()}"
    service.get_client.return_value = _upstream([500, 500, 500, 500, 500, 200])
    for _ in range(5):
        await _stream(key)
    breaker = _breaker(key)
    assert breaker.state == CircuitState.OPEN
    breaker._last_failure_time -= breaker.recovery_timeout
    assert b'"ok"' in await _stream(key)
    assert breaker.state == CircuitState.CLOSED


@pytest.mark.asyncio
async def test_call_client_errors_do_not_open_breaker(service):
    key = f"k-{uuid.uuid4()}"
    service.get_client.return_value = _upstream([400])
    for _ in range(6):
        with pytest.raises(HTTPException) as exc:
            await GatewayService.call_upstream(URL, {"model": "m"}, {}, concurrency_key=key)
        assert exc.value.status_code == 400
    assert _breaker(key).state == CircuitState.CLOSED
