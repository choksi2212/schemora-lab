#!/usr/bin/env bash
set -euo pipefail

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
status=0
timeout --signal=TERM --kill-after=2s 5s \
  idf.py -C /opt/fixture qemu --qemu-extra-args='-nographic -monitor none' \
  >"$log" 2>&1 || status="$?"

if [[ "$status" -ne 124 || ! -s /opt/fixture/build/qemu_flash.bin ]]; then
  cat "$log"
  echo "Expected IDF QEMU preparation to create qemu_flash.bin and time out (124); got $status." >&2
  exit 1
fi
