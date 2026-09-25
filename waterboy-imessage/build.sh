#!/bin/bash
# Builds dist/waterboy-imessage as a universal (arm64 + x86_64) release binary. Needs Xcode.
# Each architecture is built separately: SwiftPM's multi-arch mode (--arch a --arch b) switches to
# the Xcode build system, which can't build platform-imessage's macros and build plugins.
set -euo pipefail
cd "$(dirname "$0")"
bins=()
for arch in arm64 x86_64; do
  echo "==> building $arch"
  # A scratch path per arch: switching triples in one .build folder breaks SwiftPM's build description.
  opts=(-c release --product waterboy-imessage --triple "$arch-apple-macosx13.0" --scratch-path ".build/$arch")
  swift build "${opts[@]}"
  bins+=("$(swift build "${opts[@]}" --show-bin-path)/waterboy-imessage")
done
mkdir -p dist
lipo -create "${bins[@]}" -output dist/waterboy-imessage
lipo -info dist/waterboy-imessage
