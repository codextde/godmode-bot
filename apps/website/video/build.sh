#!/usr/bin/env bash
# Render every HyperFrames project in this folder and encode the deliverables into ../public/media/.
#   ./build.sh            render + encode everything
#   ./build.sh hero ad-vm-9x16   only these projects
# Masters (high-quality H.264) land in .renders/ (git-ignored); web/X files in ../public/media/.
# Needs: node 22+, ffmpeg (libx264 + libvpx-vp9), cwebp.
set -euo pipefail
cd "$(dirname "$0")"

HF="npx --yes hyperframes@0.8.92"
OUT=../public/media
R=.renders
mkdir -p "$OUT" "$R"

render() { (cd "$1" && $HF render --quality delivery --fps 30 --output "../$R/$1.mp4"); }

# Website loops: small H.264 (faststart) + VP9 WebM, no audio.
web() { # name crf_h264 crf_vp9
  ffmpeg -y -loglevel error -i "$R/$1.mp4" -an -c:v libx264 -preset slow -crf "$2" -pix_fmt yuv420p \
    -profile:v high -movflags +faststart "$OUT/$1.mp4"
  ffmpeg -y -loglevel error -i "$R/$1.mp4" -an -c:v libvpx-vp9 -crf "$3" -b:v 0 -row-mt 1 -deadline good \
    -cpu-used 2 -pix_fmt yuv420p "$OUT/$1.webm"
}

# X ads: high-quality H.264 High@4.2, yuv420p, 30fps, faststart (silent by design — see BRIEF.md).
ad() { # name thumb_time
  ffmpeg -y -loglevel error -i "$R/$1.mp4" -an -c:v libx264 -preset slow -crf 17 -maxrate 14M -bufsize 28M \
    -pix_fmt yuv420p -profile:v high -level:v 4.2 -r 30 -movflags +faststart "$OUT/$1.mp4"
  ffmpeg -y -loglevel error -ss "$2" -i "$R/$1.mp4" -frames:v 1 -q:v 2 "$OUT/$1.jpg"
}

still() { # name time out.jpg [out.webp]
  ffmpeg -y -loglevel error -ss "$2" -i "$R/$1.mp4" -frames:v 1 -q:v 3 "$OUT/$3"
  if [ -n "${4:-}" ]; then
    ffmpeg -y -loglevel error -ss "$2" -i "$R/$1.mp4" -frames:v 1 "$R/$1-still.png"
    cwebp -quiet -q 82 "$R/$1-still.png" -o "$OUT/$4"
  fi
}

build() {
  case "$1" in
    hero) render hero; web hero 25 38; still hero 0 hero-poster.jpg hero-poster.webp ;;
    feature-vm | feature-background | feature-vault) render "$1"; web "$1" 21 33 ;;
    ad-main-16x9 | ad-main-1x1) render "$1"; ad "$1" 1.5 ;;
    ad-vault-1x1) render "$1"; ad "$1" 1.5 ;;
    ad-vm-9x16) render "$1"; ad "$1" 1.5 ;;
    og-image) rm -rf "$R/og"; (cd og-image && $HF snapshot --at 1.9 --no-end --describe false -o "../$R/og");
      cp "$R/og/frame-00-at-1.9s.png" "$OUT/og-image.png" ;;
    *) echo "unknown project: $1" >&2; exit 1 ;;
  esac
}

if [ "$#" -eq 0 ]; then
  set -- hero feature-vm feature-background feature-vault ad-main-16x9 ad-main-1x1 ad-vault-1x1 ad-vm-9x16 og-image
fi
for p in "$@"; do echo "▸ $p"; build "$p"; done
ls -la "$OUT"
