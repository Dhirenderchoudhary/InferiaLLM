import asyncio
import os
import uuid

import asyncpg
import pytest

from cli import init

ADMIN_DSN = os.getenv("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(not ADMIN_DSN, reason="needs TEST_DATABASE_URL")


@pytest.fixture
def fresh_db():
    name = f"mig_{uuid.uuid4().hex[:8]}"

    async def _admin(sql):
        c = await asyncpg.connect(ADMIN_DSN)
        try:
            await c.execute(sql)
        finally:
            await c.close()

    asyncio.run(_admin(f'CREATE DATABASE "{name}"'))
    yield ADMIN_DSN.rsplit("/", 1)[0] + f"/{name}"
    asyncio.run(_admin(f'DROP DATABASE "{name}" WITH (FORCE)'))


def test_concurrent_runners_apply_each_migration_once(tmp_path, monkeypatch, fresh_db):
    (tmp_path / "001_table.sql").write_text(
        "CREATE TABLE t (id int);\n"
        "-- @SPLIT@\n"
        "CREATE INDEX CONCURRENTLY t_id ON t (id);\n"
    )
    (tmp_path / "002_row.sql").write_text("INSERT INTO t VALUES (1);\n")
    monkeypatch.setattr(init, "MIGRATIONS_DIR", tmp_path)

    async def run():
        await asyncio.gather(*(init._apply_migrations(fresh_db) for _ in range(4)))
        c = await asyncpg.connect(fresh_db)
        try:
            return (
                await c.fetchval("SELECT count(*) FROM schema_migrations"),
                await c.fetchval("SELECT count(*) FROM t"),
            )
        finally:
            await c.close()

    assert asyncio.run(run()) == (2, 1)
