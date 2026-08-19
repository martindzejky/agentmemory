const DEFAULT_TIMEOUT_MS = 60_000;

export function engineWatchdogTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env["AGENTMEMORY_ENGINE_WATCHDOG_MS"];
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TIMEOUT_MS;
  return n;
}

function isDown(state: unknown): boolean {
  return (
    state === "disconnected" ||
    state === "failed" ||
    state === "reconnecting"
  );
}

export function createEngineWatchdog(options: {
  timeoutMs?: number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
} = {}): {
  onConnectionState: (state: unknown) => void;
  markShuttingDown: () => void;
  stop: () => void;
} {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exit = options.exit ?? ((code) => process.exit(code));
  const log =
    options.log ??
    ((message) => {
      console.error(message);
    });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;

  function clearTimer(): void {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function arm(): void {
    if (shuttingDown || timeoutMs <= 0 || timer) return;
    timer = setTimeout(() => {
      log(
        `[agentmemory] iii-engine unreachable for ${timeoutMs}ms; exiting so the supervisor can restart`,
      );
      exit(1);
    }, timeoutMs);
  }

  return {
    onConnectionState(state: unknown) {
      if (shuttingDown) return;
      if (isDown(state)) {
        arm();
        return;
      }
      if (state === "connected") clearTimer();
    },
    markShuttingDown() {
      shuttingDown = true;
      clearTimer();
    },
    stop: clearTimer,
  };
}
