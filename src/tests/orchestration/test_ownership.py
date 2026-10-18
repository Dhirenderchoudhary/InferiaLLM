"""The ownership rule every org check in orchestration shares."""
from types import SimpleNamespace

import pytest

from orchestration.ownership import caller_org, owns, owns_pool


def _conn(org):
    return SimpleNamespace(headers={} if org is None else {"x-organization-id": org})


@pytest.mark.parametrize("header, expected", [
    ("org-a", "org-a"), (" org-a ", "org-a"), ("", ""), (None, ""),
    # The gateway's HTTP proxy sends str(None) for a user without an org.
    ("None", ""),
])
def test_caller_org(header, expected):
    assert caller_org(_conn(header)) == expected


@pytest.mark.parametrize("header, org_id, expected", [
    ("org-a", "org-a", True),
    ("org-a", "org-b", False),
    ("org-a", None, False),
    ("None", None, False),     # str(None) == "None": a naive compare would match
    ("", "", False),
    (None, "org-a", False),
])
def test_owns(header, org_id, expected):
    assert owns(_conn(header), org_id) is expected


@pytest.mark.parametrize("pool, expected", [
    ({"owner_type": "organization", "owner_id": "org-a"}, True),
    ({"owner_type": "user", "owner_id": "org-a"}, True),       # older rows
    ({"owner_type": "user", "owner_id": "some-user-id"}, False),
    ({"owner_type": "system", "owner_id": "org-a"}, False),
    ({"owner_type": "organization", "owner_id": "org-b"}, False),
    (None, False),
])
def test_owns_pool(pool, expected):
    assert owns_pool(_conn("org-a"), pool) is expected
