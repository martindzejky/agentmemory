// Short-lived cache for the enumerations behind mem::file-context.
//
// file-context runs on every file-touching tool call (via /enrich) and does one
// kv.list of KV.sessions plus one kv.list per candidate session. Measured with
// the new kv-list accounting: 16 enumerations per enrich, 3840 across 240
// enrich calls. The inputs barely change between tool calls in the same turn,
// and the candidate sessions are *other* sessions, i.e. historical and
// effectively static, so a short TTL removes almost all of that repeat work
// without changing what file-context can see.
//
// Both caches are bounded: the session list is one entry, and the per-session
// candidate lists are projected down to the fields the matcher uses and capped
// by a global entry budget so a corpus with MAX_OBS_PER_SESSION=2000 cannot
// turn this into a memory problem.

import type { CompressedObservation, Session } from "../types.js";

export interface FileCandidate {
  obsId: string;
  files: string[];
  type: string;
  title: string;
  narrative: string;
  importance: number;
  timestamp: string;
}

const SESSION_LIST_TTL_MS = 30_000;
const CANDIDATE_TTL_MS = 60_000;
// Roughly 1-2 MB at typical narrative lengths.
const MAX_CACHED_CANDIDATES = 5_000;

let sessionList: { at: number; sessions: Session[] } | null = null;

const candidatesBySession = new Map<
  string,
  { at: number; candidates: FileCandidate[] }
>();
let cachedCandidateCount = 0;

export async function getSessionsCached(
  load: () => Promise<Session[]>,
): Promise<Session[]> {
  if (sessionList && Date.now() - sessionList.at < SESSION_LIST_TTL_MS) {
    return sessionList.sessions;
  }
  const sessions = await load();
  sessionList = { at: Date.now(), sessions };
  return sessions;
}

// Only observations that could ever match are kept: file-context requires a
// non-empty files array, a title, and importance >= 4.
function project(observations: CompressedObservation[]): FileCandidate[] {
  const out: FileCandidate[] = [];
  for (const obs of observations) {
    if (!obs.files?.length || !obs.title || obs.importance < 4) continue;
    out.push({
      obsId: obs.id,
      files: obs.files,
      type: obs.type,
      title: obs.title,
      narrative: obs.narrative,
      importance: obs.importance,
      timestamp: obs.timestamp,
    });
  }
  return out;
}

export async function getFileCandidatesCached(
  sessionId: string,
  load: () => Promise<CompressedObservation[]>,
): Promise<FileCandidate[]> {
  const hit = candidatesBySession.get(sessionId);
  if (hit && Date.now() - hit.at < CANDIDATE_TTL_MS) return hit.candidates;

  const candidates = project(await load());

  // Evict oldest entries until the new one fits. Sessions are visited
  // most-recent-first, so the oldest cached entry is also the least likely to be
  // asked for again.
  if (hit) cachedCandidateCount -= hit.candidates.length;
  while (
    cachedCandidateCount + candidates.length > MAX_CACHED_CANDIDATES &&
    candidatesBySession.size > 0
  ) {
    const oldestKey = [...candidatesBySession.entries()].reduce((a, b) =>
      a[1].at <= b[1].at ? a : b,
    )[0];
    if (oldestKey === sessionId) break;
    cachedCandidateCount -= candidatesBySession.get(oldestKey)!.candidates.length;
    candidatesBySession.delete(oldestKey);
  }

  candidatesBySession.set(sessionId, { at: Date.now(), candidates });
  cachedCandidateCount += candidates.length;
  return candidates;
}

// Called when a session's observations change so the next file-context sees
// them, and with no argument by tests.
//
// A single session's write must not drop the session *list*: /observe fires on
// every tool call, and clearing the list each time reduced its cache to nothing
// (measured as 129 enumerations of 1069 sessions across 180 enrich calls). New
// sessions are picked up by the list's own TTL, and the session doing the
// writing is the one file-context excludes anyway.
export function invalidateFileContextCache(sessionId?: string): void {
  if (!sessionId) {
    sessionList = null;
    candidatesBySession.clear();
    cachedCandidateCount = 0;
    return;
  }
  const hit = candidatesBySession.get(sessionId);
  if (hit) {
    cachedCandidateCount -= hit.candidates.length;
    candidatesBySession.delete(sessionId);
  }
}

export function getFileContextCacheStats(): {
  sessions: number;
  candidates: number;
} {
  return {
    sessions: candidatesBySession.size,
    candidates: cachedCandidateCount,
  };
}
