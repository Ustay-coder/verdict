#!/usr/bin/env python3
"""Run an interactive Claude Code session in a pty and record it as asciicast v2 (exactly what the terminal drew).

usage: CLAUDE_CONFIG_DIR=… record.py <cwd> <out.cast> <prompt-file> [cols rows]

The TUI starts empty; once MCP servers have had time to connect, the prompt is typed in key by key.
The run ends when the session transcript holds a finished assistant turn containing the DONE marker.
"""
import glob, json, os, pty, re, select, signal, struct, sys, time, fcntl, termios

cwd, out, prompt_file = sys.argv[1], sys.argv[2], sys.argv[3]
cols, rows = (int(sys.argv[4]), int(sys.argv[5])) if len(sys.argv) > 5 else (100, 30)
prompt = " ".join(open(prompt_file).read().split())
HARD_TIMEOUT = 40 * 60
DONE = os.environ.get("REC_DONE", "SCORE HISTORY")   # "*" = the first finished assistant turn
STARTUP_WAIT = 12          # seconds before typing: lets the verdict MCP server connect
config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.expanduser("~/.claude"))

TOOLS = os.environ.get("REC_TOOLS", "Read,Edit,Write")
ALLOWED = os.environ.get("REC_ALLOWED", "Read Edit Write mcp__verdict").split()
MCP = ["--mcp-config", ".mcp.json"] if os.path.exists(os.path.join(cwd, ".mcp.json")) else []
argv = ["claude", *MCP, "--strict-mcp-config", "--tools", TOOLS, "--allowedTools", *ALLOWED, "--permission-mode", os.environ.get("REC_MODE", "acceptEdits")]

# A fresh, independent session: don't inherit this container's session identity or its sync channels,
# and keep transcripts on (they land in the isolated CLAUDE_CONFIG_DIR).
DROP = {"CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_TEE_SDK_STDOUT", "CLAUDE_CODE_SYNC_SESSION_REFS", "CLAUDE_CODE_SYNC_SKILLS",
        "CLAUDE_CODE_SYNC_PLUGINS", "CLAUDE_AFTER_LAST_COMPACT", "CLAUDE_PID", "CLAUDE_CODE_DIAGNOSTICS_FILE",
        "CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V"}
env = {k: v for k, v in os.environ.items() if k not in DROP}
env.update(TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows), FORCE_COLOR="1")
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(argv[0], argv, env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
start = time.time()
f = open(out, "w")
f.write(json.dumps({"version": 2, "width": cols, "height": rows, "timestamp": int(start),
                    "env": {"TERM": "xterm-256color"}, "title": "claude code: landing loop"}) + "\n")
markers = open(out + ".markers", "w")     # time marks for the editor (typing, submitted, done)
last_out = time.time()
typed = False
done_at = None
exit_sent = 0
last_check = 0
project_key = re.sub(r"[^a-zA-Z0-9]", "-", os.path.realpath(cwd))

def mark(label):
    markers.write(f"{time.time() - start:.2f}\t{label}\n"); markers.flush()

def send(s):
    os.write(fd, s.encode())

def pump(timeout):
    global last_out
    r, _, _ = select.select([fd], [], [], timeout)
    if not r:
        return True
    try:
        data = os.read(fd, 65536)
    except OSError:
        return False
    if not data:
        return False
    f.write(json.dumps([round(time.time() - start, 4), "o", data.decode("utf-8", "replace")]) + "\n"); f.flush()
    last_out = time.time()
    return True

def transcript_done():
    for p in glob.glob(os.path.join(config_dir, "projects", f"*{project_key}*", "*.jsonl")):
        if os.path.getmtime(p) < start - 1:
            continue
        for line in open(p, errors="replace"):
            try:
                e = json.loads(line)
            except Exception:
                continue
            m = e.get("message") or {}
            if e.get("type") == "assistant" and m.get("stop_reason") == "end_turn":
                txt = "".join(b.get("text", "") for b in m.get("content", []) if isinstance(b, dict))
                if DONE == "*" or DONE in txt:
                    return True
    return False

alive = True
while alive:
    now = time.time()
    if now - start > HARD_TIMEOUT:
        print("hard timeout", file=sys.stderr); mark("hard-timeout"); break
    alive = pump(0.2)
    if not typed and now - start > STARTUP_WAIT:
        mark("typing")
        for ch in prompt:
            send(ch)
            t_end = time.time() + 0.018
            while time.time() < t_end:
                pump(max(0, t_end - time.time()))
        for _ in range(10):
            pump(0.1)
        send("\r"); mark("submitted"); typed = True
    if typed and done_at is None and now - last_check > 3:
        last_check = now
        if transcript_done():
            done_at = now; mark("done")
    if done_at and time.time() - done_at > 4 and time.time() - last_out > 3 and exit_sent < 2:
        send("\x03"); pump(0.3); send("\x03"); exit_sent += 1; last_out = time.time()
    if exit_sent >= 2 and time.time() - last_out > 2:
        break

try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
f.close(); markers.close()
print(f"recorded {time.time() - start:.0f}s to {out}")
