#!/usr/bin/env bash
# Rebuild assets/audio/soundtrack.m4a: synthesize stems, mix (sound marks +8 dB), master to -16 LUFS.
# Needs python3 with numpy + scipy (PYTHON=/path/to/python to override) and ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
A=assets/audio
"$PY" scripts/make_audio.py
"$PY" - <<'PYEOF'
import numpy as np
from scipy.io import wavfile
sr, m = wavfile.read("assets/audio/music-raw.wav"); _, s = wavfile.read("assets/audio/sfx-raw.wav")
mix = m.astype(float) / 32767 + s.astype(float) / 32767 * 10 ** (8 / 20)
wavfile.write("assets/audio/mix-pre.wav", sr, (np.clip(mix / np.abs(mix).max() * 0.8, -1, 1) * 32767).astype(np.int16))
PYEOF
I=$(ffmpeg -hide_banner -nostats -i $A/mix-pre.wav -af ebur128 -f null - 2>&1 | grep -A3 "Integrated loudness" | awk '/I:/{print $2}')
G=$(awk -v i="$I" 'BEGIN{print -16.0 - i}')
ffmpeg -hide_banner -v error -y -i $A/mix-pre.wav -af "volume=${G}dB,alimiter=limit=0.84:attack=3:release=60:level=disabled" -ar 48000 $A/soundtrack.wav
ffmpeg -hide_banner -v error -y -i $A/soundtrack.wav -c:a aac -b:a 256k $A/soundtrack.m4a
mkdir -p $A/stems
ffmpeg -hide_banner -v error -y -i $A/music-raw.wav $A/stems/music.flac
ffmpeg -hide_banner -v error -y -i $A/sfx-raw.wav $A/stems/sfx.flac
rm -f $A/music-raw.wav $A/sfx-raw.wav $A/mix-pre.wav $A/soundtrack.wav
ffmpeg -hide_banner -nostats -i $A/soundtrack.m4a -af ebur128=peak=true -f null - 2>&1 | grep -A14 Summary | grep -E "I:|Peak:"
