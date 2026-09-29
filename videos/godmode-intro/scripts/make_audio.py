"""Synthesize the Godmode intro soundtrack: a warm ambient score + UI sound marks.

Everything is generated from oscillators and seeded noise, so the audio is original and
royalty-free by construction. Timings mirror the scene timelines in compositions/*.html.

    python scripts/make_audio.py  ->  assets/audio/music-raw.wav, assets/audio/sfx-raw.wav

Run scripts/build_audio.sh for the full pipeline. Mastering (as shipped in assets/audio/soundtrack.m4a): sfx +8 dB over the music, summed, gain-trimmed
to -16 LUFS integrated with ffmpeg (ebur128 measure → volume → alimiter limit=0.84), AAC 256k.
The raw stems are kept losslessly in assets/audio/stems/ (sfx still at its raw level).
"""

from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 48000
DUR = 87.0
N = int(SR * DUR)
rng = np.random.default_rng(20260930)
OUT = Path(__file__).resolve().parent.parent / "assets" / "audio"


def hz(note: str) -> float:
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    name, octave = note[:-1], int(note[-1])
    return 440.0 * 2 ** ((names[name] + 12 * (octave + 1) - 69) / 12)


def lowpass(x, cutoff, order=2):
    return sosfilt(butter(order, cutoff, "low", fs=SR, output="sos"), x, axis=0)


def highpass(x, cutoff, order=2):
    return sosfilt(butter(order, cutoff, "high", fs=SR, output="sos"), x, axis=0)


def bandpass(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x, axis=0)


def stereo(n):
    return np.zeros((n, 2))


def place(buf, sig, t, gain=1.0, pan=0.0):
    """Add a mono or stereo signal into buf at time t (seconds)."""
    i = int(t * SR)
    if i >= len(buf):
        return
    if sig.ndim == 1:
        left, right = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        sig = np.stack([sig * left * 1.414, sig * right * 1.414], axis=1)
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i] * gain


def reverb_ir(seconds=3.2, decay=0.85, seed=7):
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = r.standard_normal((n, 2)) * np.exp(-t / decay)[:, None]
    ir = lowpass(ir, 5200)
    ir[: int(0.018 * SR)] = 0  # pre-delay
    return ir / np.sqrt((ir**2).sum(axis=0))


IR = reverb_ir()


def wet(x, mix):
    w = np.stack([fftconvolve(x[:, 0], IR[:, 0])[: len(x)], fftconvolve(x[:, 1], IR[:, 1])[: len(x)]], axis=1)
    return x * (1 - mix) + w * mix * 1.6


# ---------------------------------------------------------------- score
CHORDS = {
    "Dmaj9": ("D2", ["F#3", "A3", "C#4", "E4"]),
    "Dmaj9/F#": ("F#2", ["A3", "C#4", "D4", "E4"]),
    "Bm9": ("B1", ["D3", "F#3", "A3", "C#4"]),
    "Gmaj9": ("G1", ["B2", "F#3", "A3", "D4"]),
    "Em9": ("E2", ["G3", "B3", "D4", "F#4"]),
    "Asus": ("A1", ["E3", "A3", "B3", "D4"]),
    "A": ("A1", ["E3", "A3", "C#4", "E4"]),
}
SECTIONS = [  # (start, chord)
    (0.0, "Dmaj9"), (6.0, "Bm9"), (9.0, "Gmaj9"), (12.0, "Dmaj9/F#"), (14.5, "Asus"), (15.75, "A"),
    (17.0, "Dmaj9"), (20.0, "Bm9"), (23.0, "Gmaj9"), (26.0, "Em9"), (29.0, "Asus"), (30.5, "A"),
    (32.0, "Gmaj9"), (35.75, "A"),
    (39.5, "Bm9"), (42.75, "Gmaj9"), (46.0, "Dmaj9"), (49.25, "Asus"), (50.9, "A"),
    (52.5, "Dmaj9/F#"), (54.25, "Asus"),
    (55.5, "Gmaj9"), (58.0, "Em9"), (60.5, "Bm9"), (63.0, "Asus"), (64.25, "A"),
    (65.5, "Dmaj9"), (68.25, "Bm9"), (71.0, "Gmaj9"), (73.75, "A"),
    (76.5, "Gmaj9"), (79.0, "Dmaj9"),
]


def pad_note(f, length, attack=1.4, release=1.8):
    n = int((length + release) * SR)
    t = np.arange(n) / SR
    sig = np.zeros((n, 2))
    for side, cents in ((0, (-6, 1)), (1, (-1, 6))):
        for c in cents:
            ff = f * 2 ** (c / 1200)
            for h in range(1, 7):
                amp = np.exp(-h * 0.55) / h
                sig[:, side] += amp * np.sin(2 * np.pi * ff * h * t + rng.uniform(0, 2 * np.pi))
    env = np.minimum(1.0, t / attack) * np.where(t > length, np.exp(-(t - length) / (release / 3)), 1.0)
    # slow breathing swell inside the note
    env *= 0.85 + 0.15 * np.sin(2 * np.pi * t / 5.3 + rng.uniform(0, 6.28))
    return sig * env[:, None]


def pluck(f, length=2.4):
    n = int(length * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for h, amp in enumerate([1.0, 0.42, 0.2, 0.12, 0.06, 0.035], start=1):
        sig += amp * np.sin(2 * np.pi * f * h * (1 + 0.0004 * h * h) * t) * np.exp(-t * (2.1 + 1.3 * h))
    sig *= np.minimum(1.0, t / 0.006)
    thump = lowpass(rng.standard_normal(n) * np.exp(-t / 0.004), 1400) * 0.25
    return lowpass(sig + thump, 4200)


def bell(f, length=4.0, index=2.2, ratio=3.5):
    n = int(length * SR)
    t = np.arange(n) / SR
    mod = index * np.exp(-t / 0.6) * np.sin(2 * np.pi * f * ratio * t)
    sig = np.sin(2 * np.pi * f * t + mod) * np.exp(-t / 1.1) * np.minimum(1.0, t / 0.004)
    sig += 0.35 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t / 0.5)
    return sig


def sub(f, length):
    n = int((length + 0.8) * SR)
    t = np.arange(n) / SR
    env = np.minimum(1.0, t / 0.6) * np.where(t > length, np.exp(-(t - length) / 0.25), 1.0)
    return np.sin(2 * np.pi * f * t) * env


music_pad = stereo(N + SR * 4)
music_pluck = stereo(N + SR * 4)
music_low = stereo(N + SR * 4)
music_bell = stereo(N + SR * 4)

ends = [s for s, _ in SECTIONS[1:]] + [DUR - 0.2]
for (start, name), end in zip(SECTIONS, ends):
    bass, tones = CHORDS[name]
    length = end - start
    for k, note in enumerate(tones):
        place(music_pad, pad_note(hz(note), length), start, gain=0.09 - k * 0.008)
    if start >= 32.0:
        place(music_low, sub(hz(bass), length), start, gain=0.045, pan=0.0)

# Arpeggios: density follows the story — sparse in the open, flowing in "how it works".
BPM = 80
EIGHTH = 60 / BPM / 2
ARP = [0, 2, 1, 3, 2, 1, 3, 2]
for (start, name), end in zip(SECTIONS, ends):
    _, tones = CHORDS[name]
    up = [hz(n) * 2 for n in tones]
    if start < 6.0 or start >= 79.0:
        continue
    step = EIGHTH * (2 if start < 17.0 or start >= 76.5 else 1)
    t = start
    i = 0
    while t < end - 0.05:
        f = up[ARP[i % len(ARP)]]
        vel = 0.075 if step > EIGHTH else (0.06 + 0.02 * (i % 4 == 0))
        if 32.0 <= t < 76.5:
            vel *= 1.2
        place(music_pluck, pluck(f), t, gain=vel, pan=0.35 * np.sin(i * 1.3))
        t += step
        i += 1

# Soft shaker for the "how it works" run.
for k in range(int((76.5 - 32.0) / EIGHTH)):
    t = 32.0 + k * EIGHTH
    n = int(0.06 * SR)
    tt = np.arange(n) / SR
    hit = bandpass(rng.standard_normal(n), 5500, 11000) * np.exp(-tt / 0.018)
    place(music_pluck, hit, t + (0.02 if k % 2 else 0.0), gain=0.018 if k % 2 else 0.028, pan=0.25)

# Brand chimes when the bolt tile blooms (open + end card), and a final resolve.
for t0 in (0.45, 78.55):
    for k, (note, dt) in enumerate((("D5", 0.0), ("A5", 0.12), ("F#6", 0.26))):
        place(music_bell, bell(hz(note)), t0 + dt, gain=0.07 - k * 0.012, pan=(-0.3, 0.1, 0.35)[k])
place(music_bell, bell(hz("D6"), 6.0, index=1.2), 83.2, gain=0.035, pan=0.0)

music = wet(music_pad, 0.35) + wet(music_pluck, 0.3) + music_low + wet(music_bell, 0.45)
music = lowpass(music, 9000)
music = highpass(music, 35)
music = music[:N]
# Fades: gentle in, long out.
t = np.arange(N) / SR
fade = np.minimum(1.0, t / 1.2) * np.clip((DUR - t) / 3.2, 0, 1)
music *= fade[:, None]

# ---------------------------------------------------------------- sound marks
sfx = stereo(N + SR * 3)


def pop(f0=880, f1=540, dur=0.09):
    n = int(0.22 * SR)
    tt = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-tt / (dur / 3))
    ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) + 0.18 * np.sin(2 * ph)) * np.exp(-tt / (dur / 1.6)) * np.minimum(1, tt / 0.003)


def tick(f=2300):
    n = int(0.08 * SR)
    tt = np.arange(n) / SR
    return np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.012) + 0.4 * bandpass(rng.standard_normal(n), 3000, 8000) * np.exp(-tt / 0.003)


def key():
    n = int(0.05 * SR)
    tt = np.arange(n) / SR
    click = bandpass(rng.standard_normal(n), 1800, 5200) * np.exp(-tt / 0.0045)
    thump = np.sin(2 * np.pi * 180 * tt) * np.exp(-tt / 0.01) * 0.35
    return click + thump


def whoosh(dur=0.45, lo=300, hi=2600):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    noise = rng.standard_normal(n + 2048)
    out = np.zeros(n)
    bands = 7
    for b in range(bands):
        c = lo * (hi / lo) ** (b / (bands - 1))
        filtered = bandpass(noise, c * 0.75, c * 1.33)[2048:]
        centre = b / (bands - 1)
        out += filtered * np.exp(-(((tt / dur) - centre) ** 2) / 0.03)
    env = np.sin(np.pi * np.clip(tt / dur, 0, 1)) ** 2
    return out * env / 2


def lock_blip():
    a = pop(1320, 1180, 0.05)
    b = pop(1760, 1560, 0.05)
    out = np.zeros(int(0.3 * SR))
    out[: len(a)] += a
    k = int(0.07 * SR)
    out[k : k + len(b)] += b[: len(out) - k]
    return out


def ding():
    out = np.zeros(int(1.6 * SR))
    for note, dt, g in (("B5", 0.0, 1.0), ("E6", 0.11, 0.8)):
        b = bell(hz(note), 1.4, index=1.0, ratio=2.0)
        k = int(dt * SR)
        out[k : k + len(b)] += b[: len(out) - k] * g
    return out


# S2 — agents arrive on the wall (soft, low pops).
for i, t0 in enumerate([0.45, 0.75, 1.05, 2.1, 3.5, 4.8]):
    place(sfx, pop(620, 420, 0.12), 6 + t0 + 0.2, gain=0.05, pan=-0.4 + i * 0.16)
# S3 — messages land.
for t0, g in ((2.3, 0.07), (3.3, 0.05), (5.4, 0.07), (10.2, 0.07)):
    place(sfx, pop(), 17 + t0, gain=g, pan=-0.2 if t0 < 5 else 0.25)
place(sfx, whoosh(0.35, 500, 3000), 17 + 7.15, gain=0.05, pan=0.2)
place(sfx, pop(1400, 1100, 0.05), 17 + 7.3, gain=0.05, pan=0.2)
place(sfx, tick(3100), 17 + 11.3, gain=0.05, pan=0.3)
# S4 — typing, then send.
FULL = "Log into Acme Billing and download September's invoices."
tt0 = 1.05
for i, ch in enumerate(FULL, start=1):
    tt0 += 0.085 if ch == " " else 0.045
    if i in (22, 35):
        tt0 += 0.18
    place(sfx, key(), 32 + tt0, gain=0.035 * (0.75 + 0.5 * rng.random()), pan=0.1)
SEND = tt0 + 0.45
place(sfx, tick(1500), 32 + SEND, gain=0.06)
place(sfx, whoosh(0.5, 350, 2800), 32 + SEND + 0.05, gain=0.06)
# S5 — steps check off; vault fills are marked with a two-tone lock blip.
ROWS = [0.8, 1.55, 2.55, 3.55, 4.55, 5.55, 6.55, 7.95]
for i, r in enumerate(ROWS):
    place(sfx, tick(2300 + 90 * i), 39.5 + r + 0.55, gain=0.045, pan=-0.2)
    if i in (2, 3, 4, 5):
        place(sfx, lock_blip(), 39.5 + r + 0.3, gain=0.05, pan=-0.1)
place(sfx, tick(1200), 39.5 + 6.85, gain=0.05, pan=0.3)
for k, note in enumerate(("A5", "D6")):
    place(sfx, bell(hz(note), 1.8, index=1.0, ratio=2.0), 39.5 + 8.65 + k * 0.12, gain=0.045)
# S5 — the real app: a soft chime as the answer is highlighted.
place(sfx, whoosh(0.6, 250, 1800), 39.5 + 12.45, gain=0.035)
for k, note in enumerate(("F#5", "A5")):
    place(sfx, bell(hz(note), 1.6, index=0.9, ratio=2.0), 39.5 + 14.1 + k * 0.1, gain=0.03, pan=0.1)
# S6 — the invoice automation lights up; the dream journal is swept line by line.
place(sfx, tick(2600), 55.5 + 2.9, gain=0.045, pan=0.2)
place(sfx, whoosh(0.6, 250, 1800), 55.5 + 4.95, gain=0.03)
for k, note in enumerate(("D6", "F#6", "A6", "B6")):
    place(sfx, bell(hz(note), 1.4, index=0.8, ratio=2.0), 55.5 + 6.3 + k * 0.32, gain=0.025, pan=-0.2 + 0.15 * k)
# S7 — a notification, then the phone conversation.
place(sfx, ding(), 65.5 + 1.1, gain=0.06, pan=-0.35)
for t0 in (2.45, 3.6, 4.6, 5.9, 7.0):
    place(sfx, pop(), 65.5 + t0, gain=0.055, pan=-0.35)
for i in range(8):
    place(sfx, pop(700, 520, 0.07), 65.5 + 3.1 + i * 0.16 + 0.15, gain=0.02, pan=0.2 + 0.05 * i)

sfx = wet(sfx[:N], 0.18)

# ---------------------------------------------------------------- master
mix = music + sfx
peak = np.abs(mix).max()
scale = 0.89 / peak  # headroom before loudness trim in ffmpeg
OUT.mkdir(parents=True, exist_ok=True)
for name, sig in (("music", music), ("sfx", sfx)):
    wavfile.write(OUT / f"{name}-raw.wav", SR, (np.clip(sig * scale, -1, 1) * 32767).astype(np.int16))
print("peak", peak, "scale", scale)
