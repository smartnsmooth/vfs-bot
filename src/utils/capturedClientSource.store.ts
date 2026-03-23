/**
 * `clientsource` header observed on a real browser request to
 * https://lift-api.vfsglobal.com/... (any path that sends the header).
 * Used when VFS_CLIENTSOURCE is not set.
 */

let captured: string | null = null;

/** Resolvers waiting for the first (or next new) captured value. */
const waiters: Array<(value: string) => void> = [];

export function getCapturedClientSource(): string | null {
  return captured;
}

export function setCapturedClientSource(value: string): void {
  const v = value.trim();
  if (!v) return;
  if (captured === v) return;
  captured = v;
  const q = waiters.splice(0, waiters.length);
  for (const w of q) {
    try {
      w(v);
    } catch {
      /* ignore */
    }
  }
}

export function clearCapturedClientSource(): void {
  captured = null;
}

/**
 * Resolves when {@link setCapturedClientSource} stores a non-empty value, or immediately if already set.
 * Rejects after `timeoutMs` if still empty.
 */
export function waitForClientSourceCapture(timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (captured) return Promise.resolve(captured);
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (v: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const i = waiters.indexOf(onCaptured);
      if (i >= 0) waiters.splice(i, 1);
      resolve(v);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const i = waiters.indexOf(onCaptured);
      if (i >= 0) waiters.splice(i, 1);
      reject(err);
    };

    const onAbort = () => fail(new Error("waitForClientSourceCapture aborted"));

    const onCaptured = (v: string) => finish(v);

    const timer = setTimeout(() => {
      fail(
        new Error(
          `clientsource not captured within ${timeoutMs}ms. Set VFS_CLIENTSOURCE or use the portal so a lift-api request with clientsource runs (e.g. refresh dashboard).`
        )
      );
    }, timeoutMs);

    waiters.push(onCaptured);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
