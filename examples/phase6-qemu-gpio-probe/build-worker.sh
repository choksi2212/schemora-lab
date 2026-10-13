#!/usr/bin/env bash
set -euo pipefail

cc -std=c11 -Wall -Wextra -Werror \
  /opt/probe/worker.c \
  -L/opt/qemu/build \
  -Wl,-rpath,/opt/qemu/build \
  -Wl,--no-as-needed -lqemu-xtensa \
  -o /opt/qemu/build/schemora-qemu-worker

ldd /opt/qemu/build/schemora-qemu-worker
