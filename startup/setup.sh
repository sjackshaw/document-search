#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILES="-f docker-compose.postgres.yml -f docker-compose.app.yml -f docker-compose.etl-documents.yml -f docker-compose.etl-webcrawl.yml -f docker-compose.genai-search.yml -f docker-compose.etl-claims-line.yml -f docker-compose.member-benefits-app.yml"

heading() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()      { printf '    \033[1;32m✔ %s\033[0m\n' "$1"; }
fail()    { printf '    \033[1;31m✘ %s\033[0m\n' "$1"; exit 1; }

# ── 1. Pre-flight checks ─────────────────────────────────────────────
heading "Pre-flight checks"
command -v docker  >/dev/null 2>&1 || fail "docker not found"
command -v docker  compose version >/dev/null 2>&1 || fail "docker compose not found"
docker info >/dev/null 2>&1 || fail "Docker daemon is not running"
ok "Docker available"

# ── 2. Environment file ──────────────────────────────────────────────
heading "Environment"
if [ ! -f .env ]; then
  cp .env.example .env
  ok "Created .env from .env.example"
else
  ok ".env already exists"
fi

# ── 3. Generate synthetic PDFs if missing ────────────────────────────
heading "Synthetic data"
PDF_DIR="services/etl-documents/data/pdfs"
if [ -d "$PDF_DIR" ] && [ "$(ls -1 "$PDF_DIR"/*.pdf 2>/dev/null | wc -l)" -ge 1500 ]; then
  ok "PDFs already generated ($(ls -1 "$PDF_DIR"/*.pdf | wc -l) files)"
else
  echo "    Generating 1,500 synthetic PDFs (requires fpdf2)..."
  pip3 install --quiet fpdf2
  python3 generate_synthetic.py
  ok "PDFs generated"
fi

# ── 3b. Generate synthetic web pages if missing ──────────────────────
heading "Synthetic web data"
WEB_DIR="services/etl-webcrawl/data/pages"
if [ -d "$WEB_DIR" ] && [ "$(ls -1 "$WEB_DIR"/*.html 2>/dev/null | wc -l)" -ge 700 ]; then
  ok "Web pages already generated ($(ls -1 "$WEB_DIR"/*.html | wc -l) files)"
else
  echo "    Generating 700 synthetic web pages..."
  python3 generate_synthetic_web.py
  ok "Web pages generated"
fi

# ── 3c. Generate synthetic member benefits claims if missing ─────────
heading "Synthetic claims data"
CLAIMS_FILE="services/etl-claims-line/data/primary.json"
if [ -f "$CLAIMS_FILE" ]; then
  ok "Claims data already present ($(python3 -c "import json;print(len(json.load(open('$CLAIMS_FILE'))))") claims)"
else
  echo "    Generating synthetic member benefits claims..."
  python3 generate_synthetic_claims.py
  ok "Claims data generated"
fi

# ── 4. Build images ──────────────────────────────────────────────────
heading "Building Docker images"
docker compose $COMPOSE_FILES build --parallel
ok "Images built"

# ── 5. Start Postgres and wait for healthy ───────────────────────────
heading "Starting Postgres"
docker compose $COMPOSE_FILES up -d postgres
echo "    Waiting for Postgres healthcheck..."
until docker compose $COMPOSE_FILES exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do
  sleep 1
done
ok "Postgres is ready"

# ── 6. Verify schema ────────────────────────────────────────────────
heading "Verifying database schema"
TABLE_COUNT=$(docker compose $COMPOSE_FILES exec -T postgres \
  psql -U postgres -d appdb -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null || echo "0")

if [ "$TABLE_COUNT" -ge 4 ]; then
  ok "Schema present ($TABLE_COUNT tables)"
else
  echo "    Init scripts will run on first Postgres start"
  ok "Schema will be initialised by entrypoint scripts"
fi

# ── 7. Start all services ────────────────────────────────────────────
heading "Starting all services"
docker compose $COMPOSE_FILES up -d
ok "All services started"

# ── 8. Pull Ollama model ──────────────────────────────────────────────
heading "Pulling Ollama model"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"
echo "    Pulling $OLLAMA_MODEL (this may take a few minutes on first run)..."
docker compose $COMPOSE_FILES exec -T ollama ollama pull "$OLLAMA_MODEL" || echo "    ⚠ Could not pull model — pull it manually: docker exec document-search-ollama ollama pull $OLLAMA_MODEL"
ok "Model ready"

heading "Ready"
echo "    App:          http://localhost:3000"
echo "    GenAI Chat:   http://localhost:3001"
echo "    Member Bot:   http://localhost:3002"
echo "    Ollama:       http://localhost:11434"
echo "    Postgres:     localhost:5433  (user: postgres / db: appdb)"
echo ""
echo "    View logs:   npm run dev:logs"
echo "    Stop stack:  npm run teardown"
echo ""
