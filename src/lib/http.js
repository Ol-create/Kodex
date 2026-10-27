// JSON POST with retries for rate limits (429), server errors (5xx) and
// network failures. Honours Retry-After when the provider sends it.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function backoffMs(attempt) {
  const base = Math.min(30_000, 1_000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

export async function postJson(
  url,
  body,
  { headers = {}, retries = 5, timeoutMs = 60_000, fetchImpl = fetch, sleep = defaultSleep } = {},
) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt >= retries) throw new HttpError(0, `Request to ${url} failed: ${err.message}`);
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) return res.json();

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      const detail = await res.text().catch(() => "");
      throw new HttpError(res.status, `${url} responded ${res.status}: ${detail.slice(0, 300)}`);
    }

    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
  }
}
