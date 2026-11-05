#!/usr/bin/env python3
"""SFX for video 2 from the compositor's cue sheet (<video>.cues.json). Everything is synthesized.
usage: sfx2.py video2.cues.json sfx2.wav
Score → pitch as in video 1 (pentatonic, 15 → E4 … 94 → A6); a score drop glides down from the old score's note.
"""
import json, sys, wave
import numpy as np

cues_path, out = sys.argv[1:3]
C = json.load(open(cues_path))
SR = 48000
rng = np.random.default_rng(11)

def t(n): return np.arange(n) / SR
def env(n, a=0.002, d=0.2): x = t(n); return np.minimum(1, x / max(a, 1e-4)) * np.exp(-np.maximum(0, x - a) / max(d, 1e-4))
def band(x, lo, hi):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    m = np.clip(np.minimum((f - lo * .8) / (lo * .2 + 1), (hi * 1.25 - f) / (hi * .25 + 1)), 0, 1)
    return np.fft.irfft(X * m, len(x))
def noise(d): return rng.standard_normal(int(d * SR))
def norm(x, p=1.0): m = np.max(np.abs(x)) or 1; return x / m * p
def glide(f0, f1, d): n = int(d * SR); f = np.geomspace(f0, f1, n); return np.sin(2 * np.pi * np.cumsum(f) / SR)
def sweep(d, lo0, hi0, lo1, hi1, parts=10):
    n = int(d * SR); out = np.zeros(n); src = noise(d); w = n // parts
    for i in range(parts):
        k = i / max(1, parts - 1); a = max(0, i * w - w // 2); b = min(n, (i + 1) * w + w // 2)
        out[a:b] += band(src[a:b], lo0 + (lo1 - lo0) * k, hi0 + (hi1 - hi0) * k) * np.hanning(b - a)
    return out

PENTA = [261.6256 * 2 ** (o - 4) * 2 ** (s / 12) for o in (4, 5, 6, 7) for s in (0, 2, 4, 7, 9)]
note = lambda score: PENTA[max(0, min(len(PENTA) - 1, round(score / 100 * 15)))]

def bell(freq, dur=1.6, lvl=.34):
    n = int(dur * SR); x = t(n)
    s = sum(a * np.sin(2 * np.pi * freq * r * x) * np.exp(-x / (dur * dk)) for r, a, dk in [(1, 1, 1), (2, .35, .55), (2.76, .18, .35), (4.07, .08, .2)])
    return norm(s * np.minimum(1, x / .004), lvl)
def chord(fs, dur=2.6, lvl=.4):
    n = int(dur * SR); x = t(n)
    s = sum(np.sin(2 * np.pi * f * x) + .25 * np.sin(4 * np.pi * f * x) for f in fs)
    return norm(s * np.minimum(1, x / .012) * np.exp(-x / (dur * .42)), lvl)
def thud():
    d = .55; n = int(d * SR)
    return norm(glide(90, 42, d) * env(n, .003, .16) + band(noise(d), 700, 4500) * env(n, .001, .02) * .5, .8)
def drop(f0, f1):
    d = .9; n = int(d * SR); x = t(n)
    s = glide(f0, f1, d) * np.exp(-x / .5) + .3 * glide(f0 * 2, f1 * 2, d) * np.exp(-x / .3)
    return norm(s * np.minimum(1, x / .01), .38)
def pop(f=900): d = .09; n = int(d * SR); return norm(glide(f * .8, f * 1.35, d) * env(n, .002, .03), .3)
def swap(): d = .26; n = int(d * SR); return norm(sweep(d, 400, 1500, 1800, 7000, 10) * np.sin(np.pi * t(n) / d) ** 1.4, .38)
def whoosh_big(): d = .5; n = int(d * SR); return norm(sweep(d, 250, 900, 1500, 8000, 14) * np.sin(np.pi * t(n) / d) ** 1.2, .5)
def tick(lvl=.12): d = .012; n = int(d * SR); return norm(np.sin(2 * np.pi * 2200 * t(n)) * env(n, .0005, .003), lvl)
def tick_soft(k): return bell(PENTA[2 + k % 9], .7, .14)
def mark(): d = .05; n = int(d * SR); return norm(glide(1400, 1100, d) * env(n, .001, .015) + band(noise(d), 2500, 7000) * env(n, .0005, .006) * .4, .2)
def riser(d=.6, lvl=.2): n = int(d * SR); return norm(sweep(d, 400, 1500, 2500, 9000, 12) * (t(n) / d) ** 2, lvl)
def boom():
    d = 2.2; n = int(d * SR)
    return norm(glide(70, 38, d) * env(n, .004, .5) + band(noise(d), 2000, 9000) * env(n, .002, .25) * .08, .8)

sounds = []   # (time, samples, pan)
for c in C["cues"]:
    k, at = c["kind"], c["t"]
    if k == "bell": sounds.append((at, bell(note(c["score"])), .15))
    elif k == "chord_major": sounds.append((at, chord([523.25, 659.25, 783.99, 1046.5]), 0))
    elif k == "thud": sounds.append((at, thud(), 0))
    elif k == "drop": sounds.append((at, drop(note(c["from"]), note(c["to"]) * .94), 0))
    elif k == "pop": sounds.append((at, pop(), 0))
    elif k == "swap": sounds.append((at, swap(), rng.uniform(-.3, .3)))
    elif k == "whoosh_big": sounds.append((at, whoosh_big(), 0))
    elif k == "tick_soft": sounds.append((at, tick_soft(c["k"]), (c["k"] % 2) * .4 - .2))
    elif k == "mark": sounds.append((at, mark(), rng.uniform(-.4, .4)))
    elif k == "ticks":
        for j in range(12): sounds.append((at + j * .7 / 12, tick(), .25))
    elif k == "riser": sounds.append((at, riser(), 0))
    elif k == "riser_soft": sounds.append((at, riser(1.2, .08), 0))
    elif k == "boom": sounds.append((at, boom(), 0)); sounds.append((at + .03, chord([1046.5, 1318.5, 1568.0], 2.5, .1), 0))

n = int((C["total"] + .5) * SR); mix = np.zeros((n, 2))
for at, s, pan in sounds:
    i = int(at * SR); j = min(n, i + len(s))
    if i >= n: continue
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    mix[i:j, 0] += s[: j - i] * (l * .7 + .35); mix[i:j, 1] += s[: j - i] * (r * .7 + .35)
L = int(.9 * SR); x = t(L)
for ch in range(2):
    ir = rng.standard_normal(L) * np.exp(-x / .22); ir[: int(.012 * SR)] = 0; ir /= np.sqrt(np.sum(ir ** 2))
    F = 1 << (n + L - 1).bit_length()
    mix[:, ch] += np.fft.irfft(np.fft.rfft(mix[:, ch], F) * np.fft.rfft(ir, F), F)[:n] * .18
mix = np.tanh(mix * 1.2) / np.tanh(1.2); mix = mix / np.max(np.abs(mix)) * 10 ** (-1.5 / 20)
f = int(.4 * SR); mix[-f:] *= np.linspace(1, 0, f)[:, None]
with wave.open(out, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mix * 32767).astype("<i2").tobytes())
print(f"{len(sounds)} sounds, {C['total']}s -> {out}")
