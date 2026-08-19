let supervised = false;
let shuttingDown = false;
let signalsBound = false;

function bindShutdownSignals(): void {
  if (signalsBound) return;
  signalsBound = true;
  const mark = () => {
    shuttingDown = true;
  };
  process.on("SIGINT", mark);
  process.on("SIGTERM", mark);
}

export function markEngineSupervised(): void {
  supervised = true;
  bindShutdownSignals();
}

export function markEngineShutdown(): void {
  shuttingDown = true;
}

export function exitCodeForSpawnedEngineDeath(
  code: number | null,
  signal: NodeJS.Signals | null,
): number | null {
  if (shuttingDown || !supervised) return null;
  if (code !== null && code !== 0) return code;
  return 1;
}

export function __resetEngineSuperviseForTests(): void {
  supervised = false;
  shuttingDown = false;
}
