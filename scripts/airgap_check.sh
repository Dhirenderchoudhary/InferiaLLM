#!/usr/bin/env bash
# Prove the model cache works with no internet.
#
# Stage 1 (no GPU): a real huggingface_hub client on a Docker network created
# with --internal — no NAT, so huggingface.co is unreachable — downloads an
# imported model through the mirror.
#
# Stage 2 (needs a GPU): vLLM on the same network loads that model.
#
#   ./scripts/airgap_check.sh stage1
#   ./scripts/airgap_check.sh stage2 <model-id>
#   ./scripts/airgap_check.sh clean
set -euo pipefail

APP=${APP:-inferia-app}
NET=airgap-check
MODEL=${MODEL:-airgap/demo}
STAGE_DIR=/var/lib/inferia/models/import/airgap-demo
IMAGE=$(docker inspect "$APP" --format '{{.Config.Image}}')

note() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; exit 1; }
pass() { printf 'PASS  %s\n' "$1"; }

need_key() {
  KEY=$(grep -E '^INTERNAL_API_KEY=' .env | cut -d= -f2- | tr -d '"' | tr -d '\r')
  [ -n "$KEY" ] || fail "INTERNAL_API_KEY not found in .env"
}

stage1() {
  need_key

  note "network with no route to the internet"
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --internal "$NET" >/dev/null
  docker network connect "$NET" "$APP" 2>/dev/null || true
  pass "network $NET ready, $APP attached"

  note "stage a model and import it"
  docker exec "$APP" sh -c "
    rm -rf $STAGE_DIR && mkdir -p $STAGE_DIR
    printf '{\"model_type\":\"llama\",\"hidden_size\":16}' > $STAGE_DIR/config.json
    head -c 65536 /dev/urandom > $STAGE_DIR/model.safetensors
  "
  curl -sf -o /dev/null -X POST http://localhost:8080/v1/models/import \
    -H 'Content-Type: application/json' \
    -H "X-Internal-API-Key: $KEY" -H 'X-Gateway-Request: true' \
    -d "{\"format\":\"hf\",\"from\":\"airgap-demo\",\"model_id\":\"$MODEL\"}" \
    || fail "import request rejected"

  for _ in $(seq 1 30); do
    status=$(docker exec "$APP" python -c "
import asyncio, os, asyncpg
async def m():
    c = await asyncpg.connect(os.environ['DATABASE_URL'].replace('+asyncpg',''))
    print(await c.fetchval(\"SELECT status FROM model_cache WHERE model_id=\$1\", '$MODEL') or '')
    await c.close()
asyncio.run(m())" 2>/dev/null | tr -d '\r')
    [ "$status" = "cached" ] && break
    [ "$status" = "error" ] && fail "import failed; check the row's error column"
    sleep 1
  done
  [ "$status" = "cached" ] || fail "import did not reach cached (last: ${status:-none})"
  pass "imported and cached"

  note "client with no internet downloads it through the mirror"
  docker run --rm --network "$NET" \
    -e HF_ENDPOINT="http://$APP:8000/api/hf" \
    -e HF_HUB_DISABLE_TELEMETRY=1 \
    --entrypoint python \
    "$IMAGE" -c "
import socket, sys
# Prove there is no egress before trusting the result below.
try:
    socket.create_connection(('huggingface.co', 443), timeout=5)
    sys.exit('FAIL  the network reached huggingface.co; it is not isolated')
except OSError:
    print('PASS  huggingface.co is unreachable')

from huggingface_hub import snapshot_download, hf_hub_download
p = hf_hub_download('$MODEL', 'config.json')
assert open(p).read().startswith('{'), 'config.json came back wrong'
print('PASS  hf_hub_download')

d = snapshot_download('$MODEL')
import os
names = sorted(os.listdir(d))
assert 'model.safetensors' in names, names
assert os.path.getsize(os.path.join(d, 'model.safetensors')) == 65536
print('PASS  snapshot_download, weights byte-exact')
" || fail "the offline client could not fetch the model"

  note "stage 1 complete — the mirror serves with no internet"
  echo "next: ./scripts/airgap_check.sh stage2 $MODEL   (needs a GPU host)"
}

stage2() {
  local model=${1:-$MODEL}
  note "vLLM on the isolated network, weights from the mirror only"
  docker run --rm --gpus all --network "$NET" \
    -e HF_ENDPOINT="http://$APP:8000/api/hf" \
    -e HF_HUB_OFFLINE=0 \
    docker.io/vllm/vllm-openai:v0.22.1 \
    --model "$model" --max-model-len 512 --enforce-eager \
    || fail "vLLM could not start from the mirror"
}

clean() {
  docker exec "$APP" sh -c "rm -rf $STAGE_DIR" 2>/dev/null || true
  docker network disconnect "$NET" "$APP" 2>/dev/null || true
  docker network rm "$NET" 2>/dev/null || true
  echo "removed the network and staging; the cache row is left for inspection"
}

case "${1:-}" in
  stage1) stage1 ;;
  stage2) stage2 "${2:-}" ;;
  clean)  clean ;;
  *) echo "usage: $0 {stage1|stage2 [model-id]|clean}"; exit 2 ;;
esac
