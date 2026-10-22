#!/usr/bin/env bash
# Run on another machine to pull a daily backup of the Gleeok server's data (and Vaultwarden's,
# if it runs there) over SSH. Pulled rather than pushed, so the server needs no SSH key.
#   GLEEOK_BACKUP_HOST=<ssh host of the server> deploy/backup-pull.sh
#   -> ~/backups/<host>/YYYY-MM-DD/data.tar.gz, kept 30 days.
set -euo pipefail
umask 077
host=${GLEEOK_BACKUP_HOST:?set GLEEOK_BACKUP_HOST to the ssh host running the Gleeok server}
root=~/backups/$host
dest=$root/$(date +%F)
mkdir -p "$dest"

# sqlite3 .backup gives a consistent copy while the services keep running.
ssh -o BatchMode=yes "$host" bash -s > "$dest/data.tar.gz.part" <<'REMOTE'
set -euo pipefail
umask 077
tmp=$(mktemp -d)
mkdir "$tmp/gleeok-backup"
out=$tmp/gleeok-backup
sqlite3 ~/.local/share/gleeok/gleeok.db ".backup '$out/gleeok.db'"
vw=~/.local/share/vaultwarden
if [ -f "$vw/db.sqlite3" ]; then
  sqlite3 "$vw/db.sqlite3" ".backup '$out/vaultwarden.db'"
  cp "$vw/rsa_key.pem" "$out/"
  [ -d "$vw/attachments" ] && cp -r "$vw/attachments" "$out/"
  [ -d "$vw/sends" ] && cp -r "$vw/sends" "$out/"
fi
tar -C "$tmp" -czf - gleeok-backup
rm -rf "$tmp"
REMOTE
mv "$dest/data.tar.gz.part" "$dest/data.tar.gz"
find "$root" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
echo "backup ok: $dest/data.tar.gz ($(du -h "$dest/data.tar.gz" | cut -f1))"
