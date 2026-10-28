#!/usr/bin/env bash
# Assemble the deployable static site (no tests, no dev files) into $1 (default ./_site).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/_site}"
rm -rf "$out"
mkdir -p "$out"
cd "$here"
cp index.html style.css app.js meter.js sim.js lcd.js horse.js sw.js manifest.webmanifest "$out"/
cp -r icons "$out"/
touch "$out/.nojekyll"
echo "built $(find "$out" -type f | wc -l) files, $(du -sh "$out" | cut -f1) -> $out"
