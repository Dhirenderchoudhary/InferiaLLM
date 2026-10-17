"""The user-auth middleware must not trust Upgrade or Connection headers.

It runs as an HTTP middleware, so a real websocket handshake never reaches it;
a request that carries these headers here is a plain one. With the exemption
in place, the request passed the middleware and reached body validation (422)
instead of being refused.
"""
import pytest
from fastapi.testclient import TestClient

from api_gateway.app import app

client = TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "headers",
    [
        {"Upgrade": "websocket"},
        {"Upgrade": "WebSocket"},
        {"Connection": "upgrade"},
        {"Connection": "keep-alive, Upgrade"},
    ],
)
@pytest.mark.parametrize(
    "method, path",
    [
        ("POST", "/management/users"),
        ("POST", "/management/api-keys"),
        ("PUT", "/admin/users/x/role"),
    ],
)
def test_upgrade_headers_do_not_skip_user_auth(method, path, headers):
    assert client.request(method, path, headers=headers).status_code == 401
