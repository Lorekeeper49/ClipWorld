#!/usr/bin/env bash
# Builds ClipWorld for Linux into dist/linux-unpacked/clipworld and launches it.
#   ./build.sh            build, then launch
#   ./build.sh nolaunch   build only
#   ./build.sh appimage   build the distributable AppImage and .tar.gz into dist/ instead
# (If the file is not executable yet: chmod +x build.sh, or run it as "bash build.sh".)
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-}"

fail() {
  echo
  echo "Build failed: $*"
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js was not found. Install Node.js 22 or newer (https://nodejs.org or your package manager)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js $NODE_MAJOR found; ClipWorld needs version 22 or newer."

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "Unsupported CPU architecture: $(uname -m)" ;;
esac

# A running copy locks its own files and would make the build fail.
if pgrep -f "dist/linux.*-unpacked/clipworld" >/dev/null 2>&1; then
  fail "ClipWorld is running from dist. Close it first, then run this again."
fi

if [ ! -d node_modules ]; then
  echo "=== Installing dependencies ==="
  npm install --no-fund --no-audit || fail "npm install failed"
fi

if [ ! -x "vendor/ffmpeg/linux-$ARCH/ffmpeg" ]; then
  echo "=== Downloading ffmpeg ==="
  node scripts/fetch-ffmpeg.mjs --platform linux --arch "$ARCH" || fail "could not download ffmpeg"
fi

echo "=== Type-checking ==="
npm run typecheck || fail "type errors"

if [ "$MODE" = "appimage" ]; then
  echo "=== Building AppImage and tar.gz ==="
  npx electron-vite build || fail "bundling failed"
  npx electron-builder --linux "--$ARCH" || fail "packaging failed"
  echo
  echo "Done. The AppImage and .tar.gz are in $(pwd)/dist"
  exit 0
fi

echo "=== Building app ==="
npx electron-vite build || fail "bundling failed"
npx electron-builder --linux dir "--$ARCH" || fail "packaging failed"

OUT="dist/linux-unpacked"
[ "$ARCH" = "arm64" ] && OUT="dist/linux-arm64-unpacked"
echo
echo "Done: $(pwd)/$OUT/clipworld"
[ "$MODE" = "nolaunch" ] && exit 0
# Detached, so closing this terminal does not close the app.
nohup "$OUT/clipworld" >/dev/null 2>&1 &
