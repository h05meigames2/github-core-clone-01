// Entry point: bring the forge up, hand its port to the trial env, then wait
// there until the env says the trial is finished.
//
// The env is the only client that matters here. It lives at MAKEFUN_ENV_URL
// (http://store:8080 inside a trial pod) and drives the whole lifecycle:
//
//   1. No MAKEFUN_ENV_URL means there is no env to talk to, so exit 1.
//   2. Listen on port 0 and let the kernel pick a free one. Port 8080 belongs
//      to the env, so never bind it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env records the
//      address the request came from together with N and dials that base URL
//      from then on. A 200 means it took the port; a 409 means another entry
//      registered first, and this process simply waits like any other.
//   4. GET $MAKEFUN_ENV_URL/done again and again until it answers
//      {"done": true}. While the suite is still running it answers
//      {"done": false} right away, so this is polling, not a held request.
//      A poll that fails or times out is retried — the env may still be
//      starting, and the process must never exit before the env says done.
//   5. Shut the server down and exit 0. The harness then stops the env,
//      which writes the export the scorer reads.
//
// Nothing in this file is scored except that it works: the suite grades the
// server app.ts builds. It imports that server and nothing else — no package,
// no Node built-in, no model call.

import { createApp } from './app.ts';

// The env's origin, with any trailing slashes stripped off.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set, so there is no env to register with\n');
  process.exit(1);
}

// One HTTP round trip may take this long before it is abandoned and retried.
const ROUND_TRIP_MS = 30_000;
// Backoff between retries: start here, double each time, never pass the cap.
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

/** Wait `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait after the `n`th failed attempt (0-based): exponential, capped. */
function backoffMs(n: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(n, 8));
}

/**
 * Tell the env which port the forge bound. Keeps trying until the env takes
 * the port (200) or reports that a first registration already won (409).
 * A 400 or 405 means the request itself is wrong, so those end the program;
 * anything else — a refused connection, a timeout, another status — is
 * retried, since the env may still be coming up.
 */
async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal: Error | null = null;
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ROUND_TRIP_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        fatal = new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) fatal = err;
    }
    if (fatal !== null) throw fatal;
    await pause(backoffMs(attempt));
  }
}

/**
 * Poll GET /done until the env answers {"done": true}. Any failure — the env
 * not answering yet, a timed-out poll, a non-JSON body — just means "not
 * done", so the poll is retried after a short wait.
 */
async function awaitCompletion(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(ROUND_TRIP_MS) });
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet: keep polling.
    }
    await pause(backoffMs(attempt));
  }
}

/** The whole life of the process: bind, announce the port, wait for done. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitCompletion();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
