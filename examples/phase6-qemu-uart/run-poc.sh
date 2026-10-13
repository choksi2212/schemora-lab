#!/usr/bin/env bash
set -euo pipefail

build_log="$(mktemp)"
expected_file="$(mktemp)"
run_one="$(mktemp)"
run_two="$(mktemp)"
cleanup() {
  rm -f "$build_log" "$expected_file" "$run_one" "$run_two" \
    "${run_one}.markers" "${run_two}.markers"
}
trap cleanup EXIT

if ! idf.py build >"$build_log" 2>&1; then
  cat "$build_log"
  exit 1
fi

cat >"$expected_file" <<'EXPECTED'
SCHEMORA_GPIO19_SETUP=OK
SCHEMORA_QEMU_REFERENCE_START
SCHEMORA_GPIO19_REQUESTED=1,RESULT=OK,TICK=0
SCHEMORA_GPIO19_REQUESTED=0,RESULT=OK,TICK=1
SCHEMORA_GPIO19_REQUESTED=1,RESULT=OK,TICK=2
SCHEMORA_GPIO19_REQUESTED=0,RESULT=OK,TICK=3
SCHEMORA_GPIO19_REQUESTED=1,RESULT=OK,TICK=4
SCHEMORA_QEMU_REFERENCE_COMPLETE
EXPECTED

run_qemu() {
  local log_file="$1"
  local exit_status=0
  timeout --signal=TERM --kill-after=2s 12s idf.py qemu \
    --qemu-extra-args='-nographic -monitor none' >"$log_file" 2>&1 || exit_status="$?"
  if [[ "$exit_status" -ne 124 ]]; then
    cat "$log_file"
    echo "Expected the looping fixture to be stopped by timeout (124); got $exit_status." >&2
    return 1
  fi
  grep '^SCHEMORA_' "$log_file" | tr -d '\r' >"${log_file}.markers"
}

run_qemu "$run_one"
run_qemu "$run_two"
diff -u "$expected_file" "${run_one}.markers"
diff -u "$expected_file" "${run_two}.markers"

printf 'IDF_VERSION=%s\n' "$(idf.py --version)"
printf 'QEMU_VERSION=%s\n' "$(qemu-system-xtensa --version | head -n 1)"
printf 'FIRMWARE_SHA256=%s\n' "$(sha256sum build/schemora_phase6_qemu_uart.bin | cut -d ' ' -f 1)"
printf 'POC_RUNS=2; MARKERS_MATCH=YES; PROCESS_TIMEOUT_CLEANUP=YES; GPIO_PIN_CAPTURE=NOT_AVAILABLE\n'
cat "${run_one}.markers"
