"""Whether the caller's organisation owns a deployment or pool.

The gateway forwards the caller's org as X-Organization-ID, and only it and
the host CLI hold the internal key that orchestration requires, so the header
can be trusted. A missing org owns nothing; it never means "all orgs".
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


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
        and pool.get("owner_type") in ("organization", "user")
        and owns(conn, pool.get("owner_id"))
    )


async def owns_pool_id(conn, pool_id, pool_repo) -> bool:
    """owns_pool for a pool looked up by id. Any lookup failure owns nothing."""
    if not caller_org(conn) or pool_repo is None or not pool_id:
        return False
    try:
        pool = await pool_repo.get(pool_id)
    except Exception as e:
        logger.warning("org check for pool %s failed: %s", pool_id, e)
        return False
    return owns_pool(conn, pool)


async def owns_node(conn, node_id, inventory_repo, pool_repo) -> bool:
    """Whether the node sits in a pool the caller's org owns."""
    if not caller_org(conn) or inventory_repo is None:
        return False
    try:
        node = await inventory_repo.get_node_by_id(node_id)
    except Exception as e:
        logger.warning("org check for node %s failed: %s", node_id, e)
        return False
    return bool(node) and await owns_pool_id(conn, node.get("pool_id"), pool_repo)
