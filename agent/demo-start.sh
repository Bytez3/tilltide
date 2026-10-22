#!/bin/sh
# Starts the hosted judge demo (see Dockerfile.demo): a throwaway Postgres, then the sandbox.
# Every restart begins from a clean chain and database.
set -e
PG=$(ls -d /usr/lib/postgresql/*/bin | tail -1)
DATA=/tmp/pgdata
rm -rf "$DATA" && mkdir -p "$DATA" && chown postgres "$DATA"
su postgres -c "$PG/initdb -D $DATA -A trust -U postgres" >/dev/null
su postgres -c "$PG/pg_ctl -D $DATA -o '-k /tmp -c listen_addresses=localhost' -w start" >/dev/null
su postgres -c "psql -h /tmp -U postgres -c \"create role tilltide superuser login password 'tilltide'\" -c 'create database tilltide owner tilltide'" >/dev/null
exec pnpm --filter @tilltide/agent exec tsx scripts/sandbox.ts
