#!/usr/bin/env bash
# Reset Sentry CLI authentication to replay the auto-login demo flow.
set -euo pipefail

DB="$HOME/.sentry/cli.db"

if [ -f "$DB" ]; then
  rm "$DB"
  echo "✅ Removed $DB — Sentry CLI auth reset."
  echo "   Next sentry command will trigger browser login."
else
  echo "ℹ️  $DB not found — already unauthenticated."
fi
