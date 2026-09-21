#!/usr/bin/env python3
"""Enable NODE_OPTIONS only in an explicit pi-codex private/staged runtime.

Caller must back up first, stop the app, then re-sign and verify before publishing.
Fuse wire format follows Electron schema v1; no official application is modified.
"""
import sys
from pathlib import Path

SENTINEL = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"


def enable(data):
    start = data.find(SENTINEL)
    if start < 0 or data.find(SENTINEL, start + 1) >= 0:
        raise ValueError("Expected exactly one Electron fuse wire")
    header = start + len(SENTINEL)
    if len(data) < header + 2 or data[header] != 1:
        raise ValueError("Unsupported Electron fuse schema")
    size = data[header + 1]
    wire = data[header + 2:header + 2 + size]
    if size < 3 or len(wire) != size or any(b not in b"012" for b in wire):
        raise ValueError("Invalid Electron fuse wire")
    if wire[2] == ord('2'):
        raise ValueError("NODE_OPTIONS fuse was removed")
    result = bytearray(data)
    result[header + 4] = ord('1')
    return bytes(result)


def main():
    bundle = Path(sys.argv[1]).resolve(strict=True)
    if bundle.name != 'Official.app' or not bundle.parent.name.startswith('.pi-codex.app.runtime'):
        raise ValueError("Refusing non-pi-codex private runtime; expected .pi-codex.app.runtime*/Official.app")
    frameworks = bundle / 'Contents/Frameworks'
    matches = []
    for framework in frameworks.glob('*.framework'):
        binary = (framework / 'Versions/Current' / framework.stem).resolve()
        if binary.is_file() and binary.is_relative_to(bundle):
            data = binary.read_bytes()
            if SENTINEL in data:
                matches.append((binary, data))
    if len(matches) != 1:
        raise ValueError("Expected one Electron framework")
    binary, data = matches[0]
    updated = enable(data)
    if updated != data:
        binary.write_bytes(updated)
    print('NODE_OPTIONS enabled; re-sign and verify before launch')


if __name__ == '__main__':
    main()
