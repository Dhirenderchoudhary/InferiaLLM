import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from orchestration.middleware import InternalAuthMiddleware

KEY = "test-key-32chars-aaaaaaaaaaaaaaaa"


def _client():
    app = FastAPI()

    @app.websocket("/v1/admin/workers/{node_id}/shell")
    async def shell(ws: WebSocket, node_id: str):
        await ws.accept()
        await ws.send_text("opened")
        await ws.close()

    @app.websocket("/v1/workers/channel")
    async def channel(ws: WebSocket):
        await ws.accept()
        await ws.send_text("opened")
        await ws.close()

    app.add_middleware(
        InternalAuthMiddleware,
        internal_api_key=KEY,
        skip_paths=["/v1/workers/channel"],
    )
    return TestClient(app)


def test_websocket_without_key_is_rejected():
    with pytest.raises(WebSocketDisconnect) as exc:
        with _client().websocket_connect("/v1/admin/workers/n1/shell") as ws:
            ws.receive_text()
    assert exc.value.code == 1008


def test_websocket_with_wrong_key_is_rejected():
    with pytest.raises(WebSocketDisconnect) as exc:
        with _client().websocket_connect(
            "/v1/admin/workers/n1/shell", headers={"X-Internal-API-Key": "wrong"}
        ) as ws:
            ws.receive_text()
    assert exc.value.code == 1008


def test_websocket_with_key_is_accepted():
    with _client().websocket_connect(
        "/v1/admin/workers/n1/shell", headers={"X-Internal-API-Key": KEY}
    ) as ws:
        assert ws.receive_text() == "opened"


def test_websocket_on_skip_path_is_accepted_without_key():
    with _client().websocket_connect("/v1/workers/channel") as ws:
        assert ws.receive_text() == "opened"
