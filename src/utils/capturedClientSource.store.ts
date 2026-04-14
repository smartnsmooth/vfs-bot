/**
 * `clientsource` header captured from a real browser request to
 * https://lift-api.vfsglobal.com/... (any path that sends the header).
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
 * Waits indefinitely — the bot must not proceed without a captured clientsource.
 */
export function waitForClientSourceCapture(signal?: AbortSignal): Promise<string> {
  if (captured) return Promise.resolve(captured);
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (v: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      const i = waiters.indexOf(onCaptured);
      if (i >= 0) waiters.splice(i, 1);
      resolve(v);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      const i = waiters.indexOf(onCaptured);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error("waitForClientSourceCapture aborted"));
    };

    const onCaptured = (v: string) => finish(v);

    waiters.push(onCaptured);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
