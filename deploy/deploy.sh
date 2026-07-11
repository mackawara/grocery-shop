#!/usr/bin/env bash
# Runs ON THE SERVER (invoked by the GitHub Actions deploy workflows over SSH).
#
#   deploy.sh <service> <image> <tag>      service: api | dashboard
#
# Pulls <image>:<tag>, pins it in .env, and restarts only that service
# health-gated (`up -d --wait` succeeds only once the container reports
# healthy). If the new version fails its healthcheck, automatically re-deploys
# the previously running tag and exits non-zero so the workflow fails loudly.
set -euo pipefail

SERVICE="${1:?usage: deploy.sh <api|dashboard> <image> <tag>}"
IMAGE="${2:?usage: deploy.sh <api|dashboard> <image> <tag>}"
TAG="${3:?usage: deploy.sh <api|dashboard> <image> <tag>}"

case "${SERVICE}" in
  api)
    IMAGE_VAR=API_IMAGE
    TAG_VAR=API_TAG
    ;;
  dashboard)
    IMAGE_VAR=DASHBOARD_IMAGE
    TAG_VAR=DASHBOARD_TAG
    ;;
  *)
    echo "ERROR: unknown service '${SERVICE}' (expected api or dashboard)" >&2
    exit 1
    ;;
esac

cd "$(dirname "$0")"

if [ ! -f api.env ]; then
  echo "ERROR: api.env not found — the deploy workflow writes it from GitHub secrets before calling this script (see README.md); it should never be missing." >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
fi

set_var() {
  local key=$1 value=$2
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >>.env
  fi
}

PREV_TAG="$(grep "^${TAG_VAR}=" .env | cut -d= -f2- || true)"

# Fail fast before touching any state if the image can't be pulled.
docker pull "${IMAGE}:${TAG}"

set_var "${IMAGE_VAR}" "${IMAGE}"
set_var "${TAG_VAR}" "${TAG}"

# Delete all images of this repository except the running tag and the previous
# one (kept so automatic rollback stays instant and works without Docker Hub).
# `latest` is only an alias for the newest push — untagging it costs nothing.
prune_old_images() {
  # `grep` exits 1 when nothing needs pruning — don't let pipefail turn a
  # successful deploy into a failure.
  docker images "${IMAGE}" --format '{{.Tag}}' |
    { grep -vxF -e "${TAG}" -e "${PREV_TAG:-none}" -e '<none>' || true; } |
    while read -r old_tag; do
      docker rmi "${IMAGE}:${old_tag}" >/dev/null || true
    done
  docker image prune -f >/dev/null
}

if docker compose up -d --wait "${SERVICE}"; then
  echo "Deployed ${SERVICE} ${IMAGE}:${TAG}"
  prune_old_images
  exit 0
fi

echo "Deploy of ${SERVICE}:${TAG} failed its healthcheck." >&2
docker compose logs --tail 100 "${SERVICE}" >&2 || true

if [ -n "${PREV_TAG}" ] && [ "${PREV_TAG}" != "${TAG}" ]; then
  echo "Rolling back ${SERVICE} to ${PREV_TAG}..." >&2
  set_var "${TAG_VAR}" "${PREV_TAG}"
  if docker compose up -d --wait "${SERVICE}"; then
    echo "Rolled back ${SERVICE} to ${PREV_TAG}." >&2
  else
    echo "ROLLBACK OF ${SERVICE} TO ${PREV_TAG} ALSO FAILED — manual intervention required." >&2
  fi
fi

exit 1
