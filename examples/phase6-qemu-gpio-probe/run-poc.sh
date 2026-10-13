#!/usr/bin/env bash
set -euo pipefail

worker=/opt/qemu/build/schemora-qemu-worker
firmware=/opt/fixture/build/qemu_flash.bin
run_one="$(mktemp)"
run_two="$(mktemp)"
trace_one="$(mktemp)"
trace_two="$(mktemp)"
events_one="$(mktemp)"
events_two="$(mktemp)"
filtered_events_one="$(mktemp)"
filtered_events_two="$(mktemp)"
expected_uart="$(mktemp)"
expected_gpio=/opt/probe/expected-gpio19.jsonl
trap 'rm -f "$run_one" "$run_two" "$trace_one" "$trace_two" "$events_one" "$events_two" "$filtered_events_one" "$filtered_events_two" "$expected_uart"' EXIT

source "$IDF_PATH/export.sh" >/dev/null 2>&1

cat >"$expected_uart" <<'EXPECTED'
SCHEMORA_GPIO19_SETUP=OK
SCHEMORA_QEMU_REFERENCE_START
SCHEMORA_GPIO19_REQUESTED=1,RESULT=OK,TICK=0
SCHEMORA_GPIO19_REQUESTED=0,RESULT=OK,TICK=1
SCHEMORA_GPIO19_REQUESTED=1,RESULT=OK,TICK=2
SCHEMORA_GPIO19_REQUESTED=0,RESULT=OK,TICK=3
SCHEMORA_GPIO19_REQUESTED=1,RESULT=OK,TICK=4
SCHEMORA_QEMU_REFERENCE_COMPLETE
EXPECTED

run_once() {
  local output="$1"
  local trace="$2"
  local events="$3"
  local status=0
  SCHEMORA_GPIO_TRACE="$trace" SCHEMORA_EVENT_TRACE="$events" timeout --signal=TERM --kill-after=2s 12s \
    "$worker" "$firmware" >"$output" 2>&1 || status="$?"
  if [[ "$status" -ne 124 ]]; then
    cat "$output"
    echo "Expected bounded fixture shutdown (124), got $status." >&2
    return 1
  fi
  grep '^SCHEMORA_' "$output" | tr -d '\r' >"${output}.uart"
  diff -u "$expected_uart" "${output}.uart"
  diff -u "$expected_gpio" "$trace"
  local filtered_events="$4"
  python3 /opt/probe/filter-event-trace.py "$events" "$filtered_events"
  if [[ "${SCHEMORA_CAPTURE_EVENTS:-0}" != "1" ]]; then
    diff -u /opt/probe/expected-events.jsonl "$filtered_events"
  fi
}

run_once "$run_one" "$trace_one" "$events_one" "$filtered_events_one"
run_once "$run_two" "$trace_two" "$events_two" "$filtered_events_two"
diff -u "$filtered_events_one" "$filtered_events_two"

printf 'QEMU_SOURCE_REVISION=%s\n' "$QEMU_SOURCE_REVISION"
printf 'QEMU_VERSION=%s\n' "$(cat /opt/qemu/VERSION)"
printf 'IDF_VERSION=%s\n' "$(idf.py --version)"
printf 'FIRMWARE_SHA256=%s\n' "$(sha256sum /opt/fixture/build/schemora_phase6_qemu_uart.bin | cut -d ' ' -f 1)"
printf 'HOST_ABI=registered_callback; RUNS=2; UART_TRACE_MATCH=YES; GPIO19_TRACE_MATCH=YES; NETWORK_INTERFACE=NONE; TIMEOUT_CLEANUP=YES\n'
dpkg-query -W -f='${binary:Package}=${Version}\n' build-essential git libfdt-dev libgcrypt20-dev libglib2.0-dev libpixman-1-dev libslirp-dev libusb-1.0-0-dev libzstd-dev ninja-build pkg-config
cat "$trace_one"
printf 'SCHEMORA_EVENT_TRACE_BEGIN\n'
cat "$filtered_events_one"
printf 'SCHEMORA_EVENT_TRACE_END\n'
