#!/usr/bin/env bash
# Creates a dedicated Postgres 16 cluster ("rag", port 5433) inside WSL with
# pgvector enabled. The existing "main" cluster on 5432 is left untouched.
#
# Run from Windows:  wsl -d Ubuntu -u root bash scripts/setup-wsl-db.sh
# or inside WSL:     sudo bash scripts/setup-wsl-db.sh
set -euo pipefail

PG_VERSION=16
CLUSTER=rag
PORT=5433
DB_NAME=rag
DB_USER=rag
DB_PASS="${RAG_DB_PASSWORD:-rag_dev_password}"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

as_postgres() {
  if [ -z "$SUDO" ]; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi
}

echo "==> Installing pgvector"
# WSL often resolves IPv6 addresses it cannot route, so force IPv4.
APT_OPTS=(-o Acquire::ForceIPv4=true -o Acquire::Retries=3)
$SUDO apt-get "${APT_OPTS[@]}" update -qq
$SUDO apt-get "${APT_OPTS[@]}" install -y -qq "postgresql-${PG_VERSION}-pgvector"

echo "==> Creating cluster ${CLUSTER} on port ${PORT}"
if ! pg_lsclusters -h | awk '{print $2}' | grep -qx "$CLUSTER"; then
  $SUDO pg_createcluster "$PG_VERSION" "$CLUSTER" --port "$PORT"
fi

# Windows reaches WSL through localhost forwarding, so listen beyond the
# unix socket and allow password auth over TCP.
$SUDO pg_conftool "$PG_VERSION" "$CLUSTER" set listen_addresses '*'
HBA="/etc/postgresql/${PG_VERSION}/${CLUSTER}/pg_hba.conf"
if ! grep -q "rag-service" "$HBA"; then
  echo "host all all 0.0.0.0/0 scram-sha-256 # rag-service (Windows -> WSL)" | $SUDO tee -a "$HBA" >/dev/null
fi

$SUDO pg_ctlcluster "$PG_VERSION" "$CLUSTER" stop 2>/dev/null || true
$SUDO pg_ctlcluster "$PG_VERSION" "$CLUSTER" start

echo "==> Creating role and database"
# SUPERUSER is for local dev only: Prisma's shadow database needs to run
# CREATE EXTENSION vector during `prisma migrate dev`.
as_postgres psql -p "$PORT" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN SUPERUSER PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SQL

if ! as_postgres psql -p "$PORT" -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  as_postgres createdb -p "$PORT" -O "$DB_USER" "$DB_NAME"
fi

as_postgres psql -p "$PORT" -d "$DB_NAME" -qc "CREATE EXTENSION IF NOT EXISTS vector;"
VECTOR_VERSION=$(as_postgres psql -p "$PORT" -d "$DB_NAME" -tAc "SELECT extversion FROM pg_extension WHERE extname = 'vector'")

echo
echo "Done. pgvector ${VECTOR_VERSION} enabled."
echo "DATABASE_URL=\"postgresql://${DB_USER}:${DB_PASS}@localhost:${PORT}/${DB_NAME}\""
