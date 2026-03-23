#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILES="-f docker-compose.postgres.yml -f docker-compose.app.yml -f docker-compose.etl-documents.yml -f docker-compose.etl-webcrawl.yml -f docker-compose.genai-search.yml"

heading() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()      { printf '    \033[1;32m✔ %s\033[0m\n' "$1"; }

heading "Stopping containers"
docker compose $COMPOSE_FILES down --remove-orphans
ok "Containers stopped"

heading "Removing volumes"
docker compose $COMPOSE_FILES down -v
ok "Volumes removed"

heading "Teardown complete"
