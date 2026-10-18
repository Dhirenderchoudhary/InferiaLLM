"""Whether the caller's organisation owns a deployment or pool.

The gateway forwards the caller's org as X-Organization-ID, and only it and
the host CLI hold the internal key that orchestration requires, so the header
can be trusted. A missing org owns nothing; it never means "all orgs".
"""
from __future__ import annotations


def caller_org(conn) -> str:
    """The forwarded org, or "" when there is none.

    The gateway's HTTP proxy sends str(None) for a user without an org.
    """
    org = (conn.headers.get("x-organization-id") or "").strip()
    return "" if org == "None" else org


def owns(conn, org_id) -> bool:
    """Whether the caller's org is ``org_id``. A record with no org has no owner."""
    org = caller_org(conn)
    return bool(org) and bool(org_id) and str(org_id) == org


def owns_pool(conn, pool) -> bool:
    """Whether the caller's org owns ``pool`` (a row with owner_type, owner_id).

    Older pools can be stored as owner_type "user" holding the org's id, so
    both types count. A system pool belongs to no org.
    """
    return (
        pool is not None
        and pool["owner_type"] in ("organization", "user")
        and owns(conn, pool["owner_id"])
    )
