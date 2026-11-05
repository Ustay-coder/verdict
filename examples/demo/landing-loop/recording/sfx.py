#!/usr/bin/env python3
"""Synthesize the SFX track for the final edit from the same timeline the picture uses.

usage: sfx.py data.json sfx.wav cues.json   (data.json from build_edit_data.py)
       ffmpeg -i final.mp4 -i sfx.wav -map 0:v -map 1:a -c:v copy -af volume=-2dB -c:a aac -b:a 192k final-sfx.mp4
Every cue time comes from data.json (real edit / evaluate moments mapped through the edit's time warp) or from the
fixed scene timings in edit.mjs. All sounds are synthesized here (no samples, nothing to license).
Score → pitch: each evaluation's "ding" is a pentatonic note proportional to its score; the score-history bars replay them.
"""
import json, sys, wave
import numpy as np

data_path, out_wav, out_cues = sys.argv[1:4]
D = json.load(open(data_path))
SR = 48000
rng = np.random.default_rng(7)

# ---- timeline: mirror edit.mjs exactly ----
SPLIT = 8.3
segs, acc = [], 0.0
for a, b, sp in D["segments"]:
    segs.append((a, b, sp, SPLIT + acc)); acc += (b - a) / sp
BOARD = SPLIT + acc + 0.3
END = BOARD + 5.5
TOTAL = END + 3.8
def vid(src):
    for a, b, sp, v0 in segs:
        if src <= b:
            return v0 + max(0.0, src - a) / sp
    return segs[-1][3] + (segs[-1][1] - segs[-1][0]) / segs[-1][2]

# ---- dsp helpers ----
def t(n): return np.arange(n) / SR
def env(n, attack=0.002, decay=0.2, curve=1.0):
    x = t(n); e = np.minimum(1.0, x / max(attack, 1e-4)) * np.exp(-np.maximum(0, x - attack) / max(decay, 1e-4))
    return e ** curve
def band(x, lo, hi):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    m = np.clip(np.minimum((f - lo * 0.8) / (lo * 0.2 + 1), (hi * 1.25 - f) / (hi * 0.25 + 1)), 0, 1)
    return np.fft.irfft(X * m, len(x))
def noise(dur): return rng.standard_normal(int(dur * SR))
def sine(freq, dur, phase=0.0):
    x = t(int(dur * SR)); f = np.broadcast_to(np.asarray(freq, float), x.shape) if np.ndim(freq) else freq
    return np.sin(2 * np.pi * np.cumsum(np.full(x.shape, 1.0) * f) / SR + phase) if np.ndim(freq) else np.sin(2 * np.pi * freq * x + phase)
def norm(x, peak=1.0): m = np.max(np.abs(x)) or 1; return x / m * peak
def sweep_noise(dur, lo0, hi0, lo1, hi1, parts=10):
    n = int(dur * SR); out = np.zeros(n); src = noise(dur); w = n // parts
    for i in range(parts):
        k = i / max(1, parts - 1); s0 = max(0, i * w - w // 2); s1 = min(n, (i + 1) * w + w // 2)
        seg = band(src[s0:s1], lo0 + (lo1 - lo0) * k, hi0 + (hi1 - hi0) * k) * np.hanning(s1 - s0)
        out[s0:s1] += seg
    return out

# ---- instruments ----
def stamp():           # low thud + paper slap
    d = 0.6; n = int(d * SR)
    body = sine(np.linspace(95, 45, n), d) * env(n, 0.003, 0.16)
    slap = band(noise(d), 800, 5000) * env(n, 0.001, 0.025)
    return norm(body * 1.0 + slap * 0.55, 0.95)
def highlighter(k):    # felt-tip swipe, slightly varied
    d = 0.16 + rng.uniform(-0.02, 0.03); n = int(d * SR)
    x = sweep_noise(d, 1500, 3500, 2600 + k * 60, 6500, parts=6) * np.sin(np.pi * t(n) / d) ** 0.7
    return norm(x, 0.35)
def key_click():
    d = 0.03; n = int(d * SR)
    x = band(noise(d), 1800, 6000) * env(n, 0.0005, 0.006) + sine(rng.uniform(170, 230), d) * env(n, 0.001, 0.01) * 0.4
    return norm(x, rng.uniform(0.2, 0.32))
def return_key():
    d = 0.08; n = int(d * SR)
    return norm(band(noise(d), 600, 4000) * env(n, 0.0008, 0.018) + sine(140, d) * env(n, 0.001, 0.03) * 0.6, 0.4)
def whoosh(strength=1.0, dur=0.32):
    n = int(dur * SR)
    x = sweep_noise(dur, 300, 1200, 1500, 7000, parts=12) * np.sin(np.pi * t(n) / dur) ** 1.5
    return norm(x, 0.55 * strength)
def pop(freq=900):
    d = 0.09; n = int(d * SR)
    return norm(sine(np.linspace(freq * 0.8, freq * 1.35, n), d) * env(n, 0.002, 0.03), 0.36)
def tick():
    d = 0.012; n = int(d * SR)
    return norm(sine(2200, d) * env(n, 0.0005, 0.003) + band(noise(d), 3000, 8000) * env(n, 0.0003, 0.002) * 0.3, 0.12)
def bell(freq, dur=1.6, level=0.5):   # soft FM-ish bell: fundamental + slightly inharmonic partials
    n = int(dur * SR); x = t(n)
    partials = [(1.0, 1.0, 1.0), (2.0, 0.35, 0.55), (2.76, 0.18, 0.35), (4.07, 0.08, 0.2)]
    s = sum(a * np.sin(2 * np.pi * freq * r * x) * np.exp(-x / (dur * dk)) for r, a, dk in partials)
    return norm(s * np.minimum(1, x / 0.004), level)
def chord(freqs, dur=2.4, level=0.55):
    n = int(dur * SR); x = t(n)
    s = sum(np.sin(2 * np.pi * f * x) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.0 * x)) for f in freqs)
    s += 0.25 * sum(np.sin(2 * np.pi * 2 * f * x) for f in freqs)
    e = np.minimum(1, x / 0.012) * np.exp(-x / (dur * 0.42))
    return norm(s * e, level)
def boom():
    d = 2.2; n = int(d * SR)
    return norm(sine(np.linspace(70, 38, n), d) * env(n, 0.004, 0.5) + band(noise(d), 2000, 9000) * env(n, 0.002, 0.25) * 0.08, 0.8)
def riser(dur=0.6):
    n = int(dur * SR); x = sweep_noise(dur, 400, 1500, 2500, 9000, parts=12) * (t(n) / dur) ** 2
    return norm(x, 0.18)

PENTA = []
for octave in (4, 5, 6, 7):
    for semis in (0, 2, 4, 7, 9):
        PENTA.append(261.6256 * 2 ** (octave - 4) * 2 ** (semis / 12))
def score_note(score): return PENTA[2 + round(score / 100 * 15) - 2]   # 15→E4 … 94→A6

# ---- cues ----
cues = []   # (time, name, sound, pan)
def cue(time, name, snd, pan=0.0): cues.append((round(time, 4), name, snd, pan))

cue(0.33, "stamp", stamp())
for k in range(12): cue(2.6 + k * 0.2, f"highlight {k + 1}", highlighter(k), rng.uniform(-0.35, 0.35))
for i in range(5): cue(5.7 + i * 0.42, f"yaml level {i + 1}", bell(PENTA[i + 2], 1.0, 0.28), (i - 2) * 0.12)
cue(5.15, "transition yaml", whoosh(0.6, 0.35))
cue(8.15, "transition split", whoosh(0.8, 0.4))

typing_src0, submit_src = 12.37, D.get("submittedSrc", 23.11)
v0, v1 = vid(typing_src0), vid(submit_src - 1.0)
tt = v0
while tt < v1:
    cue(tt, "key", key_click(), rng.uniform(-0.25, 0.25)); tt += rng.uniform(0.045, 0.085)
cue(vid(submit_src), "return", return_key())

for k, s in enumerate(D["states"][1:], 1):
    v = vid(s["src"]); cue(v, f"edit {k}: remove", whoosh(1.0)); cue(v + 0.45, f"edit {k}: add", pop(700 + 60 * k))
prev = None
for k, e in enumerate(D["evals"]):
    v = vid(e["src"]); n_ticks = 12
    for j in range(n_ticks): cue(v + j * 0.7 / n_ticks, f"count {e['score']}", tick(), 0.25)
    cue(v + 0.7, f"score {e['score']} ({e['grade']})", bell(score_note(e["score"]), 1.8, 0.36), 0.2)
    if k == len(D["evals"]) - 1:
        cue(v + 0.95, "ship it", chord([523.25, 659.25, 783.99, 1046.5], 3.0, 0.42), 0.0)
    prev = e
cue(BOARD - 0.1, "transition board", whoosh(0.7, 0.4))
for k, e in enumerate(D["evals"]):
    cue(BOARD + 0.3 + k * 0.32 + 0.45, f"board bar {k}", bell(score_note(e["score"]), 1.0, 0.26), -0.3 + k * 0.1)
cue(END - 0.6, "riser", riser(0.6))
cue(END + 0.02, "logo", boom())
cue(END + 0.05, "logo shimmer", chord([1046.5, 1318.5, 1568.0], 2.5, 0.12))

# ---- mix ----
n = int((TOTAL + 0.5) * SR)
mix = np.zeros((n, 2))
for time, name, snd, pan in cues:
    i = int(time * SR); j = min(n, i + len(snd))
    if i >= n: continue
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    mix[i:j, 0] += snd[: j - i] * l * 1.414 * 0.5 + snd[: j - i] * 0.5 * 0.7
    mix[i:j, 1] += snd[: j - i] * r * 1.414 * 0.5 + snd[: j - i] * 0.5 * 0.7
# small room reverb (FFT convolution with decaying stereo noise IR), mixed in at ~18%
ir_len = int(0.9 * SR); irt = t(ir_len)
for ch in range(2):
    ir = rng.standard_normal(ir_len) * np.exp(-irt / 0.22); ir[: int(0.012 * SR)] = 0; ir /= np.sqrt(np.sum(ir ** 2))
    L = n + ir_len; F = 1 << (L - 1).bit_length()
    wet = np.fft.irfft(np.fft.rfft(mix[:, ch], F) * np.fft.rfft(ir, F), F)[:n]
    mix[:, ch] = mix[:, ch] + wet * 0.18
# soft limiter + peak normalize to -1.5 dBFS
mix = np.tanh(mix * 1.2) / np.tanh(1.2)
mix = mix / np.max(np.abs(mix)) * 10 ** (-1.5 / 20)
fade = int(0.4 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
with wave.open(out_wav, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
json.dump({"total": TOTAL, "board": BOARD, "end": END, "cues": [{"t": c[0], "name": c[1]} for c in cues if c[1] not in ("key",) and not c[1].startswith("count")]},
          open(out_cues, "w"), indent=1)
print(f"{len(cues)} cues, {TOTAL:.2f}s -> {out_wav}")
for c in sorted(cues, key=lambda c: c[0]):
    if c[1] in ("key",) or c[1].startswith("count") or c[1].startswith("highlight"): continue
    print(f"  {c[0]:6.2f}  {c[1]}")
