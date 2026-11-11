#!/bin/sh
set -eu
store_path="${TOKEN_STORE_PATH:-/data/ebay-tokens.enc}"
store_dir=$(dirname "$store_path")
mkdir -p "$store_dir"
if [ "$(id -u)" = "0" ]; then
  chown -R app:app "$store_dir"
  exec su-exec app node dist/index.js
fi
exec node dist/index.js
