import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// /session/end is a deprecated noop for open-ended Cursor chats.
// It must not stamp completed/endedAt or fan out event::session::stopped.
describe("api::session::end is a deprecated noop", () => {
  const api = readFileSync("src/triggers/api.ts", "utf-8");
  const endHandler = api.match(
    /registerFunction\("api::session::end"[\s\S]*?registerTrigger\(\{[\s\S]*?api_path:\s*"\/agentmemory\/session\/end"/,
  )?.[0] ?? "";

  it("keeps the /agentmemory/session/end route", () => {
    expect(api).toContain('api_path: "/agentmemory/session/end"');
  });

  it("does not stamp endedAt or completed status", () => {
    expect(endHandler).not.toContain('path: "endedAt"');
    expect(endHandler).not.toContain('value: "completed"');
    expect(endHandler).not.toContain("kv.update");
  });

  it("does not trigger event::session::stopped", () => {
    expect(endHandler).not.toContain('function_id: "event::session::stopped"');
  });

  it("returns success with noop", () => {
    expect(endHandler).toMatch(/success:\s*true,\s*noop:\s*true/);
  });
});

describe("event::session::ended is a deprecated noop", () => {
  const events = readFileSync("src/triggers/events.ts", "utf-8");
  const endedHandler = events.match(
    /registerFunction\(\s*"event::session::ended"[\s\S]*?registerTrigger\(\{[\s\S]*?topic:\s*"agentmemory\.session\.ended"/,
  )?.[0] ?? "";

  it("keeps the agentmemory.session.ended subscriber", () => {
    expect(events).toContain('topic: "agentmemory.session.ended"');
  });

  it("does not stamp endedAt or completed status", () => {
    expect(endedHandler).not.toContain('path: "endedAt"');
    expect(endedHandler).not.toContain('value: "completed"');
    expect(endedHandler).not.toContain("kv.update");
  });

  it("returns success with noop", () => {
    expect(endedHandler).toMatch(/success:\s*true,\s*noop:\s*true/);
  });
});

// #666: viewer's "Build Graph" button used to POST /agentmemory/graph/build
// which returned 404 because the endpoint was never registered. Backfill
// the knowledge graph from existing compressed observations across every
// session in batches.
describe("api::graph-build endpoint (#666)", () => {
  const api = readFileSync("src/triggers/api.ts", "utf-8");

  it("registers api::graph-build function", () => {
    expect(api).toMatch(/registerFunction\("api::graph-build"/);
  });

  it("registers HTTP trigger at /agentmemory/graph/build", () => {
    expect(api).toMatch(
      /api_path:\s*"\/agentmemory\/graph\/build",\s*http_method:\s*"POST"/,
    );
  });

  it("iterates sessions and calls mem::graph-extract", () => {
    expect(api).toMatch(/kv\.list<Session>\(KV\.sessions\)/);
    expect(api).toMatch(/kv\.list<CompressedObservation>\(KV\.observations\(sid\)\)/);
    expect(api).toMatch(
      /sdk\.trigger\(\{\s*function_id:\s*"mem::graph-extract"/,
    );
  });

  it("filters observations that have a title (compressed only)", () => {
    expect(api).toMatch(/typeof o\.title === "string" && o\.title\.length > 0/);
  });

  it("respects batchSize override with a 100-item upper bound", () => {
    expect(api).toMatch(/Math\.min\(100,\s*Number\(.*batchSize/);
  });

  it("response shape matches what the viewer expects (success + nodes)", () => {
    expect(api).toMatch(/success:\s*true,\s*sessions:[\s\S]*?nodes:\s*totalNodes/);
  });
});

// #666: `agentmemory status` showed Memories/Observations as 0 because it
// fetched /agentmemory/export which times out on iii-engine's file-based
// KV under concurrent kv.list() pressure. Switch to /memories for the
// memory count and derive observation count from sessions[].observationCount.
describe("agentmemory status no longer depends on /export (#666)", () => {
  const cli = readFileSync("src/cli.ts", "utf-8");

  it("status uses count-only memories endpoint instead of export", () => {
    expect(cli).toMatch(/apiFetch<any>\(base,\s*"memories\?count=true"\)/);
    expect(cli).not.toMatch(/apiFetch<any>\(base,\s*"export"\)/);
  });

  it("status derives obsCount from sessions[].observationCount", () => {
    expect(cli).toMatch(
      /sessionList\.reduce\([\s\S]*?observationCount/,
    );
  });

  it("status reads memCount from memoriesRes.latestCount (count endpoint)", () => {
    expect(cli).toMatch(/memoriesRes\?\.latestCount\s*\?\?\s*memoriesRes\?\.total/);
  });
});
