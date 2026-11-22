#!/usr/bin/env bash
# Copyright (C) 2026 Lorekeeper49
#
# This file is part of ClipWorld.
#
# ClipWorld is free software: you can redistribute it and/or modify it under the terms of the GNU
# General Public License as published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# ClipWorld is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
# even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
# General Public License for more details.
#
# You should have received a copy of the GNU General Public License along with ClipWorld. If not,
# see <https://www.gnu.org/licenses/>.

# Puts together the complete source code of the ffmpeg that ClipWorld bundles (the build pinned in
# scripts/ffmpeg-build.json), as the GPL asks of anyone who hands out the binaries:
#   - FFmpeg itself, at the exact commit the binaries were built from
#   - the source of every library built into them (each exactly as FFmpeg-Builds downloaded it)
#   - the FFmpeg-Builds scripts, patches and configure flags that built them
# The result is <output>/ffmpeg-source-<build>.tar, split into .tar.part00, .part01 ... when it is
# bigger than a GitHub release file may be, plus <output>/ffmpeg-source-<build>.sha256.
#
# Needs Linux with git, node, xz and Docker: FFmpeg-Builds downloads the library sources inside its
# own container, the same way it does for its builds. GitHub Actions runs this for each release
# (.github/workflows/ffmpeg-source.yml), so it never has to run on your own computer.
# Usage: scripts/ffmpeg-source.sh <output folder>
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "${1:?Usage: scripts/ffmpeg-source.sh <output folder>}"
out="$(cd "$1" && pwd)"
lock="$root/scripts/ffmpeg-build.json"
val() { node -p "require(process.argv[1])[process.argv[2]]" "$lock" "$1"; }
builder="$(val builder)"
build="$(val buildTag)"
build_commit="$(val buildCommit)"
variant="$(val variant)"
addin="$(val addin)"
ffmpeg_version="$(val ffmpegVersion)"
ffmpeg_commit="$(val ffmpegCommit)"
targets="$(node -p "Object.values(require(process.argv[1]).files).map((f) => f.target).join(' ')" "$lock")"

name="ffmpeg-source-$build"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stage="$work/$name"
mkdir -p "$stage/libraries"

echo "=== FFmpeg-Builds scripts at $build_commit"
git init -q "$work/builder"
git -C "$work/builder" fetch -q --depth 1 "$builder.git" "$build_commit"
git -C "$work/builder" checkout -q FETCH_HEAD
git -C "$work/builder" archive --format=tar --prefix=FFmpeg-Builds/ HEAD | xz -T0 > "$stage/FFmpeg-Builds-$build_commit.tar.xz"

echo "=== FFmpeg $ffmpeg_version ($ffmpeg_commit)"
git init -q "$work/ffmpeg"
git -C "$work/ffmpeg" fetch -q --depth 1 https://github.com/FFmpeg/FFmpeg.git "$ffmpeg_commit"
git -C "$work/ffmpeg" archive --format=tar --prefix="ffmpeg-$ffmpeg_version/" FETCH_HEAD | xz -T0 > "$stage/ffmpeg-$ffmpeg_version.tar.xz"
rm -rf "$work/ffmpeg"

echo "=== Library sources"
(
  cd "$work/builder"
  # FFmpeg-Builds names its container images after the repository it runs in: use its own.
  export GITHUB_REPOSITORY=ffmpeg-builds/ffmpeg-builds
  # Its build recipe for each system names the source archive of every library that goes into it.
  for target in $targets; do
    ./generate.sh "$target" "$variant" "$addin" > /dev/null
    grep -o '\.cache/downloads/[^ ",]*\.tar\.xz' Dockerfile >> "$work/used.txt"
  done
  ./download.sh
)
count=0
while read -r file; do
  mv "$work/builder/$file" "$stage/libraries/"
  count=$((count + 1))
done < <(sort -u "$work/used.txt")
[ "$count" -gt 0 ] || { echo "No library sources were found in the build recipes." >&2; exit 1; }
echo "$count library source archives"

cat > "$stage/README.txt" <<EOF
Complete source code of the ffmpeg and ffprobe that ClipWorld bundles
=====================================================================

The ffmpeg and ffprobe programs that come with ClipWorld are FFmpeg $ffmpeg_version, built
by FFmpeg-Builds ($builder) in its build $build, as static GPL builds for
$targets. They are free software under the GNU General Public License, version 3.

This archive holds everything they are made from:

  ffmpeg-$ffmpeg_version.tar.xz
      FFmpeg itself, at commit $ffmpeg_commit
      (https://github.com/FFmpeg/FFmpeg/tree/$ffmpeg_commit).

  FFmpeg-Builds-$build_commit.tar.xz
      The scripts that built them: the build environment (images/), every library's version and
      build steps (scripts.d/), patches (patches/), and FFmpeg's configure flags (variants/,
      addins/). Their ffmpeg -version output also lists the configure flags.

  libraries/
      The source code of every library built into them ($count archives), exactly as
      FFmpeg-Builds downloads it. Each is named <stage>_<hash>.tar.xz, the name FFmpeg-Builds
      looks for in its download cache.

To build them again, unpack FFmpeg-Builds-$build_commit.tar.xz, put the files from libraries/
into its .cache/downloads folder, and follow its README (for example: ./build.sh win64 $variant $addin).
FFmpeg-Builds' build.sh clones FFmpeg's release branch when it builds. To build this exact FFmpeg,
put ffmpeg-$ffmpeg_version.tar.xz in a git repository and point build.sh at it with
FFMPEG_REPO_OVERRIDE and GIT_BRANCH_OVERRIDE (see build.sh).
EOF

echo "=== Packing"
rm -f "$out/$name".*
tar -C "$work" -cf - "$name" | split -b 1900M -d -a 2 - "$out/$name.tar.part"
parts=("$out/$name.tar.part"*)
if [ "${#parts[@]}" -eq 1 ]; then
  mv "${parts[0]}" "$out/$name.tar"
fi
(cd "$out" && sha256sum "$name".tar* > "$name.sha256")
ls -l "$out"
