#!/usr/bin/env python3
"""Keep only fixture protocol UART bytes while retaining GPIO/UART order."""

import json
import sys


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: filter-event-trace.py RAW_JSONL FILTERED_JSONL")

    with open(sys.argv[1], "r", encoding="utf-8") as source:
        events = [json.loads(line) for line in source if line.strip()]

    uart_events = [event for event in events if event.get("type") == "uart_byte"]
    selected_sequences: set[int] = set()
    line: list[dict[str, int | str]] = []

    for event in uart_events:
        if event.get("uart") != 0 or not isinstance(event.get("value"), int):
            raise ValueError("combined trace contains an unsupported UART event")
        if not 0 <= event["value"] <= 255:
            raise ValueError("UART byte is outside the byte range")
        line.append(event)
        if event["value"] == 10:
            payload = bytes(item["value"] for item in line)
            if payload.startswith(b"SCHEMORA_"):
                selected_sequences.update(item["sequence"] for item in line)
            line.clear()

    if line:
        payload = bytes(item["value"] for item in line)
        if payload.startswith(b"SCHEMORA_"):
            raise ValueError("fixture protocol line is incomplete")

    previous = 0
    selected = []
    for event in events:
        sequence = event.get("sequence")
        if not isinstance(sequence, int) or sequence <= previous:
            raise ValueError("callback sequence must be strictly increasing")
        previous = sequence
        kind = event.get("type")
        if kind == "gpio_level":
            if event.get("gpio") != 19 or event.get("level") not in (0, 1):
                raise ValueError("combined trace contains an unsupported GPIO event")
            selected.append(event)
        elif kind == "uart_byte":
            if sequence in selected_sequences:
                selected.append(event)
        else:
            raise ValueError(f"unsupported callback event type: {kind!r}")

    # The raw stream includes variable-length QEMU boot diagnostics. Renumber
    # only after filtering so the stable trace encodes relative callback order.
    with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as output:
        for sequence, event in enumerate(selected, start=1):
            event["sequence"] = sequence
            output.write(json.dumps(event, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
