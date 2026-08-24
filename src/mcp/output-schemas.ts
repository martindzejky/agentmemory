import {
  action,
  actionEdge,
  arraySchema,
  auditEntry,
  checkpoint,
  commitLink,
  compactLessonResult,
  compactSearchResult,
  compressedObservation,
  crystal,
  diagnosticCheck,
  facet,
  failureResult,
  fullSearchHit,
  graphEdge,
  graphNode,
  insight,
  lease,
  lesson,
  memory,
  memorySlot,
  narrativeSearchHit,
  objectSchema,
  oneOfSchema,
  projectProfile,
  routineRun,
  searchMeta,
  sentinel,
  session,
  signal,
  sketch,
  snapshotMeta,
  stringArray,
  teamSharedItem,
  toolErrorResult,
  withFailure,
  withFailureAndUnavailable,
  withUnavailable,
} from "./json-schema.js";
import type { JsonSchema } from "./json-schema.js";

const recallFull = objectSchema(
  {
    format: { type: "string", const: "full" },
    results: arraySchema(fullSearchHit),
    ...searchMeta,
  },
  ["format", "results", "tokens_used", "truncated"],
);

const recallCompact = objectSchema(
  {
    format: { type: "string", const: "compact" },
    results: arraySchema(compactSearchResult),
    ...searchMeta,
  },
  ["format", "results", "tokens_used", "truncated"],
);

const recallNarrative = objectSchema(
  {
    format: { type: "string", const: "narrative" },
    results: arraySchema(narrativeSearchHit),
    text: { type: "string" },
    ...searchMeta,
  },
  ["format", "results", "text", "tokens_used", "truncated"],
);

export const memory_recall = oneOfSchema(recallFull, recallCompact, recallNarrative);

export const memory_compress_file = withFailure(
  oneOfSchema(
    objectSchema(
      {
        success: { type: "boolean", const: true },
        filePath: { type: "string" },
        backupPath: { type: "string" },
        originalChars: { type: "number" },
        compressedChars: { type: "number" },
      },
      ["success", "filePath", "backupPath", "originalChars", "compressedChars"],
    ),
    objectSchema(
      {
        success: { type: "boolean", const: true },
        skipped: { type: "boolean", const: true },
        reason: { type: "string" },
      },
      ["success", "skipped", "reason"],
    ),
  ),
);

export const memory_save = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      memory,
      similarTo: objectSchema(
        {
          id: { type: "string" },
          title: { type: "string" },
          similarity: { type: "number" },
        },
        ["id", "title", "similarity"],
        { additionalProperties: true },
      ),
    },
    ["success", "memory"],
  ),
);

export const memory_file_history = objectSchema(
  {
    context: { type: "string" },
    files: stringArray,
  },
  ["context"],
);

export const memory_patterns = objectSchema(
  {
    patterns: arraySchema(
      objectSchema(
        {
          type: { type: "string", enum: ["co_change", "error_repeat", "workflow"] },
          description: { type: "string" },
          files: stringArray,
          frequency: { type: "number" },
          sessions: stringArray,
        },
        ["type", "description", "files", "frequency", "sessions"],
      ),
    ),
  },
  ["patterns"],
);

export const memory_sessions = objectSchema(
  { sessions: arraySchema(session) },
  ["sessions"],
);

export const memory_smart_search = oneOfSchema(
  objectSchema(
    {
      mode: { type: "string", const: "compact" },
      results: arraySchema(compactSearchResult),
      lessons: arraySchema(compactLessonResult),
      error: { type: "string" },
    },
    ["mode", "results"],
  ),
  objectSchema(
    {
      mode: { type: "string", const: "expanded" },
      results: arraySchema(
        objectSchema(
          {
            obsId: { type: "string" },
            sessionId: { type: "string" },
            observation: compressedObservation,
          },
          ["obsId", "sessionId", "observation"],
        ),
      ),
      truncated: { type: "boolean" },
    },
    ["mode", "results", "truncated"],
  ),
);

export const memory_vision_search = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      results: arraySchema(
        objectSchema(
          {
            imageRef: { type: "string" },
            score: { type: "number" },
            sessionId: { type: "string" },
            observationId: { type: "string" },
            updatedAt: { type: "string" },
          },
          ["imageRef", "score", "updatedAt"],
        ),
      ),
      total: { type: "number" },
    },
    ["success", "results", "total"],
  ),
);

export const memory_timeline = oneOfSchema(
  objectSchema(
    {
      entries: arraySchema(
        objectSchema(
          {
            observation: compressedObservation,
            sessionId: { type: "string" },
            relativePosition: { type: "number" },
          },
          ["observation", "sessionId", "relativePosition"],
        ),
      ),
      anchorIndex: { type: "number" },
    },
    ["entries", "anchorIndex"],
  ),
  objectSchema(
    {
      entries: arraySchema({ type: "object", additionalProperties: true }),
      anchor: { type: "string" },
      reason: { type: "string" },
    },
    ["entries", "anchor", "reason"],
  ),
);

export const memory_profile = oneOfSchema(
  objectSchema(
    {
      profile: projectProfile,
      cached: { type: "boolean" },
    },
    ["profile", "cached"],
  ),
  objectSchema(
    {
      profile: { type: "null" },
      reason: { type: "string" },
    },
    ["profile", "reason"],
  ),
  failureResult,
);

export const memory_export = oneOfSchema(
  objectSchema(
    {
      version: { type: "string" },
      exportedAt: { type: "string" },
      sessions: arraySchema(session),
      observations: { type: "object", additionalProperties: arraySchema(compressedObservation) },
      rawEvents: { type: "object", additionalProperties: { type: "array", items: { type: "object", additionalProperties: true } } },
      memories: arraySchema(memory),
      summaries: arraySchema({ type: "object", additionalProperties: true }),
      profiles: { type: "array", items: projectProfile },
      graphNodes: { type: "array", items: graphNode },
      graphEdges: { type: "array", items: graphEdge },
      pagination: objectSchema(
        {
          offset: { type: "number" },
          limit: { type: "number" },
          total: { type: "number" },
          hasMore: { type: "boolean" },
        },
        ["offset", "limit", "total", "hasMore"],
      ),
    },
    ["version", "exportedAt", "sessions", "observations", "memories", "summaries"],
    { additionalProperties: true },
  ),
  objectSchema(
    {
      success: { type: "boolean", const: false },
      error: { type: "string" },
      oversized: { type: "boolean", const: true },
      bytes: { type: "number" },
      limitBytes: { type: "number" },
    },
    ["success", "error", "oversized", "bytes", "limitBytes"],
  ),
);

export const memory_relations = objectSchema(
  {
    results: arraySchema(
      objectSchema(
        {
          memory,
          hop: { type: "number" },
          confidence: { type: "number" },
        },
        ["memory", "hop", "confidence"],
      ),
    ),
  },
  ["results"],
);

export const memory_commit_lookup = objectSchema(
  {
    commit: { oneOf: [commitLink, { type: "null" }] },
    sessions: arraySchema(session),
  },
  ["commit", "sessions"],
);

export const memory_commits = objectSchema(
  { commits: arraySchema(commitLink) },
  ["commits"],
);

export const memory_claude_bridge_sync = withFailureAndUnavailable(
  oneOfSchema(
    objectSchema(
      {
        success: { type: "boolean", const: true },
        content: { type: "string" },
        parsed: { type: "boolean" },
        sections: { type: "object", additionalProperties: { type: "string" } },
      },
      ["success", "content"],
    ),
    objectSchema(
      {
        success: { type: "boolean", const: true },
        path: { type: "string" },
        lines: { type: "number" },
      },
      ["success", "path", "lines"],
    ),
  ),
);

export const memory_graph_query = withUnavailable(
  objectSchema(
    {
      nodes: arraySchema(graphNode),
      edges: arraySchema(graphEdge),
      depth: { type: "number" },
      totalNodes: { type: "number" },
      totalEdges: { type: "number" },
      truncated: { type: "boolean" },
      limit: { type: "number" },
      offset: { type: "number" },
      fromSnapshot: { type: "boolean" },
      warning: { type: "string" },
    },
    ["nodes", "edges", "depth"],
  ),
);

export const memory_consolidate = withUnavailable(
  oneOfSchema(
    objectSchema(
      {
        success: { type: "boolean", const: true },
        results: { type: "object", additionalProperties: true },
      },
      ["success", "results"],
    ),
    objectSchema(
      {
        success: { type: "boolean", const: false },
        skipped: { type: "boolean" },
        reason: { type: "string" },
      },
      ["success", "skipped", "reason"],
      { additionalProperties: true },
    ),
  ),
);

export const memory_team_share = withFailureAndUnavailable(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      sharedItem: teamSharedItem,
    },
    ["success", "sharedItem"],
  ),
);

export const memory_team_feed = withUnavailable(
  objectSchema(
    {
      items: arraySchema(teamSharedItem),
      total: { type: "number" },
    },
    ["items", "total"],
  ),
);

export const memory_audit = oneOfSchema(
  objectSchema(
    { entries: arraySchema(auditEntry) },
    ["entries"],
  ),
  toolErrorResult,
);

export const memory_governance_delete = oneOfSchema(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      deleted: { type: "number" },
      total: { type: "number" },
    },
    ["success", "deleted", "total"],
  ),
  failureResult,
  toolErrorResult,
);

export const memory_snapshot_create = withFailureAndUnavailable(
  oneOfSchema(
    objectSchema(
      {
        success: { type: "boolean", const: true },
        message: { type: "string" },
      },
      ["success", "message"],
    ),
    objectSchema(
      {
        success: { type: "boolean", const: true },
        snapshot: snapshotMeta,
      },
      ["success", "snapshot"],
    ),
  ),
);

export const memory_action_create = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      action,
      edges: arraySchema(actionEdge),
    },
    ["success", "action", "edges"],
  ),
);

export const memory_action_update = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      action,
    },
    ["success", "action"],
  ),
);

export const memory_frontier = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      frontier: arraySchema(
        objectSchema(
          {
            action,
            score: { type: "number" },
            blockers: stringArray,
            leased: { type: "boolean" },
          },
          ["action", "score", "blockers", "leased"],
        ),
      ),
      totalActions: { type: "number" },
      totalUnblocked: { type: "number" },
    },
    ["success", "frontier", "totalActions", "totalUnblocked"],
  ),
);

export const memory_next = oneOfSchema(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      suggestion: {
        oneOf: [
          objectSchema(
            {
              actionId: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              priority: { type: "number" },
              score: { type: "number" },
              tags: stringArray,
            },
            ["actionId", "title", "description", "priority", "score", "tags"],
          ),
          { type: "null" },
        ],
      },
      message: { type: "string" },
      totalActions: { type: "number" },
      totalUnblocked: { type: "number" },
    },
    ["success", "suggestion", "message", "totalActions"],
  ),
  objectSchema(
    {
      success: { type: "boolean", const: false },
      suggestion: { type: "null" },
      message: { type: "string" },
      totalActions: { type: "number" },
    },
    ["success", "suggestion", "message", "totalActions"],
  ),
);

export const memory_lease = withFailure(
  oneOfSchema(
    objectSchema(
      {
        success: { type: "boolean", const: true },
        lease,
        renewed: { type: "boolean" },
        message: { type: "string" },
      },
      ["success", "lease"],
    ),
    objectSchema(
      {
        success: { type: "boolean", const: true },
        released: { type: "boolean" },
      },
      ["success", "released"],
    ),
  ),
);

export const memory_routine_run = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      run: routineRun,
      actionsCreated: { type: "number" },
    },
    ["success", "run", "actionsCreated"],
  ),
);

export const memory_signal_send = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      signal,
    },
    ["success", "signal"],
  ),
);

export const memory_signal_read = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      signals: arraySchema(signal),
    },
    ["success", "signals"],
  ),
);

export const memory_checkpoint = withFailure(
  oneOfSchema(
    objectSchema(
      {
        success: { type: "boolean", const: true },
        checkpoint,
        unblockedCount: { type: "number" },
      },
      ["success", "checkpoint"],
    ),
    objectSchema(
      {
        success: { type: "boolean", const: true },
        checkpoints: arraySchema(checkpoint),
      },
      ["success", "checkpoints"],
    ),
  ),
);

export const memory_mesh_sync = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      results: arraySchema(
        objectSchema(
          {
            peerId: { type: "string" },
            peerName: { type: "string" },
            pushed: { type: "number" },
            pulled: { type: "number" },
            errors: stringArray,
          },
          ["peerId", "peerName", "pushed", "pulled", "errors"],
          { additionalProperties: true },
        ),
      ),
    },
    ["success", "results"],
  ),
);

export const memory_sentinel_create = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      sentinel,
    },
    ["success", "sentinel"],
  ),
);

export const memory_sentinel_trigger = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      sentinel,
      unblockedCount: { type: "number" },
    },
    ["success", "sentinel", "unblockedCount"],
  ),
);

export const memory_sketch_create = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      sketch,
    },
    ["success", "sketch"],
  ),
);

export const memory_sketch_promote = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      promotedIds: stringArray,
    },
    ["success", "promotedIds"],
  ),
);

export const memory_crystallize = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      crystal,
    },
    ["success", "crystal"],
  ),
);

export const memory_diagnose = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      checks: arraySchema(diagnosticCheck),
      summary: objectSchema(
        {
          pass: { type: "number" },
          warn: { type: "number" },
          fail: { type: "number" },
          fixable: { type: "number" },
        },
        ["pass", "warn", "fail", "fixable"],
      ),
    },
    ["success", "checks", "summary"],
  ),
);

export const memory_heal = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      fixed: { type: "number" },
      skipped: { type: "number" },
      details: stringArray,
    },
    ["success", "fixed", "skipped", "details"],
  ),
);

export const memory_facet_tag = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      facet,
      skipped: { type: "boolean" },
    },
    ["success", "facet"],
  ),
);

export const memory_facet_query = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      results: arraySchema(
        objectSchema(
          {
            targetId: { type: "string" },
            targetType: { type: "string" },
            matchedFacets: stringArray,
          },
          ["targetId", "targetType", "matchedFacets"],
        ),
      ),
    },
    ["success", "results"],
  ),
);

export const memory_verify = withFailure(
  oneOfSchema(
    objectSchema(
      {
        success: { type: "boolean", const: true },
        type: { type: "string", const: "memory" },
        memory: { type: "object", additionalProperties: true },
        citations: { type: "array", items: { type: "object", additionalProperties: true } },
        citationCount: { type: "number" },
      },
      ["success", "type", "memory", "citations", "citationCount"],
    ),
    objectSchema(
      {
        success: { type: "boolean", const: true },
        type: { type: "string", const: "observation" },
        observation: { type: "object", additionalProperties: true },
        session: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
        citationCount: { type: "number" },
        citations: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      ["success", "type", "observation", "session", "citationCount", "citations"],
    ),
  ),
);

export const memory_lesson_save = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      action: { type: "string", enum: ["created", "strengthened"] },
      lesson,
    },
    ["success", "action", "lesson"],
  ),
);

export const memory_lesson_recall = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      lessons: arraySchema(lesson),
    },
    ["success", "lessons"],
  ),
);

export const memory_lesson_delete = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      lesson,
    },
    ["success", "lesson"],
  ),
);

export const memory_obsidian_export = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      exported: objectSchema(
        {
          memories: { type: "number" },
          lessons: { type: "number" },
          crystals: { type: "number" },
          sessions: { type: "number" },
        },
        ["memories", "lessons", "crystals", "sessions"],
      ),
      errors: arraySchema(
        objectSchema(
          { path: { type: "string" }, error: { type: "string" } },
          ["path", "error"],
        ),
      ),
      vaultDir: { type: "string" },
    },
    ["success", "exported", "vaultDir"],
  ),
);

export const memory_reflect = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      newInsights: { type: "number" },
      reinforced: { type: "number" },
      clustersProcessed: { type: "number" },
      clustersSkipped: { type: "number" },
      usedFallback: { type: "boolean" },
    },
    [
      "success",
      "newInsights",
      "reinforced",
      "clustersProcessed",
      "clustersSkipped",
      "usedFallback",
    ],
  ),
);

export const memory_insight_list = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      insights: arraySchema(insight),
    },
    ["success", "insights"],
  ),
);

export const memory_slot_list = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      slots: arraySchema(memorySlot),
    },
    ["success", "slots"],
  ),
);

export const memory_slot_get = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      slot: memorySlot,
      scope: { type: "string", enum: ["project", "global"] },
    },
    ["success", "slot", "scope"],
  ),
);

export const memory_slot_create = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      slot: memorySlot,
    },
    ["success", "slot"],
  ),
);

export const memory_slot_append = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      slot: memorySlot,
      size: { type: "number" },
    },
    ["success", "slot", "size"],
  ),
);

export const memory_slot_replace = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
      slot: memorySlot,
      size: { type: "number" },
    },
    ["success", "slot", "size"],
  ),
);

export const memory_slot_delete = withFailure(
  objectSchema(
    {
      success: { type: "boolean", const: true },
    },
    ["success"],
  ),
);

export const toolOutputSchemas = {
  memory_recall,
  memory_compress_file,
  memory_save,
  memory_file_history,
  memory_patterns,
  memory_sessions,
  memory_smart_search,
  memory_vision_search,
  memory_timeline,
  memory_profile,
  memory_export,
  memory_relations,
  memory_commit_lookup,
  memory_commits,
  memory_claude_bridge_sync,
  memory_graph_query,
  memory_consolidate,
  memory_team_share,
  memory_team_feed,
  memory_audit,
  memory_governance_delete,
  memory_snapshot_create,
  memory_action_create,
  memory_action_update,
  memory_frontier,
  memory_next,
  memory_lease,
  memory_routine_run,
  memory_signal_send,
  memory_signal_read,
  memory_checkpoint,
  memory_mesh_sync,
  memory_sentinel_create,
  memory_sentinel_trigger,
  memory_sketch_create,
  memory_sketch_promote,
  memory_crystallize,
  memory_diagnose,
  memory_heal,
  memory_facet_tag,
  memory_facet_query,
  memory_verify,
  memory_lesson_save,
  memory_lesson_recall,
  memory_lesson_delete,
  memory_obsidian_export,
  memory_reflect,
  memory_insight_list,
  memory_slot_list,
  memory_slot_get,
  memory_slot_create,
  memory_slot_append,
  memory_slot_replace,
  memory_slot_delete,
} as const satisfies Record<string, JsonSchema>;

export type ToolOutputName = keyof typeof toolOutputSchemas;
