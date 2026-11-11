export async function fetchWithTimeout(f: typeof fetch, url: string, ms: number, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await f(url, { ...init, signal: ctrl.signal, headers: { "user-agent": "verdict-engine/0.1 (+https://github.com/verdict)", accept: "text/html,application/json,text/plain,*/*", ...(init.headers ?? {}) } });
  } finally { clearTimeout(t); }
}
