#!/bin/sh
# Consistent online backup of the hosted database (safe while Tape runs).
# Usage: ./backup.sh [dest-dir]   (cron it daily; keep DATA_KEY stored separately)
set -eu
DEST=${1:-./backups}
COMPOSE="docker compose -f $(dirname "$0")/docker-compose.hosted.yml"
mkdir -p "$DEST"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
$COMPOSE exec -T tape node --disable-warning=ExperimentalWarning -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DATABASE_PATH || '/data/tape.db');
  db.exec(\"VACUUM INTO '/data/backup.db'\");
"
$COMPOSE cp tape:/data/backup.db "$DEST/tape-$STAMP.db"
$COMPOSE exec -T tape rm -f /data/backup.db
find "$DEST" -name 'tape-*.db' -mtime +14 -delete
echo "Backup written to $DEST/tape-$STAMP.db"
