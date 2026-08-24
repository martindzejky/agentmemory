export type JsonSchema = {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null"
    | Array<"object" | "array" | "string" | "number" | "integer" | "boolean" | "null">;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  description?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  minItems?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
};

export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  extra: Omit<JsonSchema, "type" | "properties" | "required"> = {},
): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: extra.additionalProperties ?? false,
    ...omitAdditional(extra),
  };
}

function omitAdditional(
  extra: Omit<JsonSchema, "type" | "properties" | "required">,
): Omit<JsonSchema, "type" | "properties" | "required" | "additionalProperties"> {
  const { additionalProperties: _ignored, ...rest } = extra;
  return rest;
}

export function arraySchema(items: JsonSchema, extra: Partial<JsonSchema> = {}): JsonSchema {
  return { type: "array", items, ...extra };
}

export function oneOfSchema(...schemas: JsonSchema[]): JsonSchema {
  return { oneOf: schemas };
}

export function stringEnum(values: string[]): JsonSchema {
  return { type: "string", enum: values };
}

export function nullableObject(schema: JsonSchema): JsonSchema {
  return { oneOf: [schema, { type: "null" }] };
}

export const stringArray = arraySchema({ type: "string" });
export const numberArray = arraySchema({ type: "number" });

export const failureResult = objectSchema(
  {
    success: { type: "boolean", const: false },
    error: { type: "string" },
  },
  ["success", "error"],
  { additionalProperties: true },
);

export const unavailableResult = objectSchema(
  {
    status: { type: "string", const: "unavailable" },
    message: { type: "string" },
  },
  ["status", "message"],
);

export const toolErrorResult = objectSchema(
  {
    status: { type: "string", const: "error" },
    message: { type: "string" },
  },
  ["status", "message"],
);

export function withFailure(success: JsonSchema): JsonSchema {
  return oneOfSchema(success, failureResult);
}

export function withUnavailable(success: JsonSchema): JsonSchema {
  return oneOfSchema(success, unavailableResult);
}

export function withFailureAndUnavailable(success: JsonSchema): JsonSchema {
  return oneOfSchema(success, failureResult, unavailableResult);
}

export const origin = objectSchema(
  {
    channel: stringEnum(["user", "agent", "tool", "import", "shared"]),
    detail: { type: "string" },
    capturedAt: { type: "string" },
  },
  ["channel", "capturedAt"],
  { additionalProperties: true },
);

export const observationType = stringEnum([
  "file_read",
  "file_write",
  "file_edit",
  "command_run",
  "search",
  "web_fetch",
  "conversation",
  "error",
  "decision",
  "discovery",
  "subagent",
  "notification",
  "task",
  "image",
  "other",
]);

export const compressedObservation = objectSchema(
  {
    id: { type: "string" },
    sessionId: { type: "string" },
    timestamp: { type: "string" },
    type: observationType,
    title: { type: "string" },
    subtitle: { type: "string" },
    facts: stringArray,
    narrative: { type: "string" },
    concepts: stringArray,
    files: stringArray,
    importance: { type: "number" },
    confidence: { type: "number" },
    imageRef: { type: "string" },
    imageData: { type: "string" },
    imageDescription: { type: "string" },
    modality: stringEnum(["text", "image", "mixed"]),
    agentId: { type: "string" },
    derivedBy: stringEnum(["synthetic", "llm"]),
    origin,
  },
  [
    "id",
    "sessionId",
    "timestamp",
    "type",
    "title",
    "facts",
    "narrative",
    "concepts",
    "files",
    "importance",
  ],
  { additionalProperties: true },
);

export const memory = objectSchema(
  {
    id: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    type: stringEnum([
      "pattern",
      "preference",
      "architecture",
      "bug",
      "workflow",
      "fact",
    ]),
    title: { type: "string" },
    content: { type: "string" },
    concepts: stringArray,
    files: stringArray,
    sessionIds: stringArray,
    strength: { type: "number" },
    version: { type: "number" },
    parentId: { type: "string" },
    supersedes: stringArray,
    relatedIds: stringArray,
    sourceObservationIds: stringArray,
    isLatest: { type: "boolean" },
    forgetAfter: { type: "string" },
    imageRef: { type: "string" },
    imageData: { type: "string" },
    agentId: { type: "string" },
    project: { type: "string" },
    origin,
  },
  [
    "id",
    "createdAt",
    "updatedAt",
    "type",
    "title",
    "content",
    "concepts",
    "files",
    "sessionIds",
    "strength",
    "version",
    "isLatest",
  ],
  { additionalProperties: true },
);

export const session = objectSchema(
  {
    id: { type: "string" },
    project: { type: "string" },
    cwd: { type: "string" },
    startedAt: { type: "string" },
    endedAt: { type: "string" },
    status: stringEnum(["active", "completed", "abandoned"]),
    observationCount: { type: "number" },
    model: { type: "string" },
    tags: stringArray,
    firstPrompt: { type: "string" },
    summary: { type: "string" },
    commitShas: stringArray,
    agentId: { type: "string" },
    updatedAt: { type: "string" },
    lastEventAt: { type: "string" },
    lastSummarizedEventId: { type: "string" },
    lastSummarizedEventAt: { type: "string" },
    lastReflectedEventId: { type: "string" },
    lastReflectedEventAt: { type: "string" },
    lastGraphExtractedEventId: { type: "string" },
    lastGraphExtractedEventAt: { type: "string" },
    summaryRevision: { type: "number" },
    summarizedObservationCount: { type: "number" },
    lastSweepAttemptAt: { type: "string" },
  },
  ["id", "project", "cwd", "startedAt", "status", "observationCount"],
  { additionalProperties: true },
);

export const sessionSummary = objectSchema(
  {
    sessionId: { type: "string" },
    project: { type: "string" },
    createdAt: { type: "string" },
    title: { type: "string" },
    narrative: { type: "string" },
    keyDecisions: stringArray,
    filesModified: stringArray,
    concepts: stringArray,
    observationCount: { type: "number" },
  },
  [
    "sessionId",
    "project",
    "createdAt",
    "title",
    "narrative",
    "keyDecisions",
    "filesModified",
    "concepts",
    "observationCount",
  ],
  { additionalProperties: true },
);

export const compactSearchResult = objectSchema(
  {
    obsId: { type: "string" },
    sessionId: { type: "string" },
    title: { type: "string" },
    type: observationType,
    score: { type: "number" },
    timestamp: { type: "string" },
  },
  ["obsId", "sessionId", "title", "type", "score", "timestamp"],
);

export const compactLessonResult = objectSchema(
  {
    lessonId: { type: "string" },
    content: { type: "string" },
    confidence: { type: "number" },
    score: { type: "number" },
    createdAt: { type: "string" },
    project: { type: "string" },
    tags: stringArray,
  },
  ["lessonId", "content", "confidence", "score", "createdAt", "tags"],
);

export const fullSearchHit = objectSchema(
  {
    observation: compressedObservation,
    score: { type: "number" },
    sessionId: { type: "string" },
  },
  ["observation", "score", "sessionId"],
);

export const narrativeSearchHit = objectSchema(
  {
    obsId: { type: "string" },
    sessionId: { type: "string" },
    title: { type: "string" },
    narrative: { type: "string" },
    score: { type: "number" },
    timestamp: { type: "string" },
  },
  ["obsId", "sessionId", "title", "narrative", "score", "timestamp"],
);

export const searchMeta = {
  tokens_used: { type: "number" },
  tokens_budget: { type: "number" },
  truncated: { type: "boolean" },
} satisfies Record<string, JsonSchema>;

export const auditEntry = objectSchema(
  {
    id: { type: "string" },
    timestamp: { type: "string" },
    operation: { type: "string" },
    userId: { type: "string" },
    functionId: { type: "string" },
    targetIds: stringArray,
    details: { type: "object", additionalProperties: true },
    qualityScore: { type: "number" },
  },
  ["id", "timestamp", "operation", "functionId", "targetIds", "details"],
  { additionalProperties: true },
);

export const action = objectSchema(
  {
    id: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    status: stringEnum(["pending", "active", "done", "blocked", "cancelled"]),
    priority: { type: "number" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    createdBy: { type: "string" },
    assignedTo: { type: "string" },
    project: { type: "string" },
    tags: stringArray,
    sourceObservationIds: stringArray,
    sourceMemoryIds: stringArray,
    result: { type: "string" },
    parentId: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
    sketchId: { type: "string" },
    crystallizedInto: { type: "string" },
  },
  [
    "id",
    "title",
    "description",
    "status",
    "priority",
    "createdAt",
    "updatedAt",
    "createdBy",
    "tags",
    "sourceObservationIds",
    "sourceMemoryIds",
  ],
  { additionalProperties: true },
);

export const actionEdge = objectSchema(
  {
    id: { type: "string" },
    type: stringEnum([
      "requires",
      "unlocks",
      "spawned_by",
      "gated_by",
      "conflicts_with",
    ]),
    sourceActionId: { type: "string" },
    targetActionId: { type: "string" },
    createdAt: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
  },
  ["id", "type", "sourceActionId", "targetActionId", "createdAt"],
  { additionalProperties: true },
);

export const lease = objectSchema(
  {
    id: { type: "string" },
    actionId: { type: "string" },
    agentId: { type: "string" },
    acquiredAt: { type: "string" },
    expiresAt: { type: "string" },
    renewedAt: { type: "string" },
    status: stringEnum(["active", "expired", "released"]),
  },
  ["id", "actionId", "agentId", "acquiredAt", "expiresAt", "status"],
  { additionalProperties: true },
);

export const signal = objectSchema(
  {
    id: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    threadId: { type: "string" },
    replyTo: { type: "string" },
    type: stringEnum(["info", "request", "response", "alert", "handoff"]),
    content: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
    createdAt: { type: "string" },
    readAt: { type: "string" },
    expiresAt: { type: "string" },
  },
  ["id", "from", "type", "content", "createdAt"],
  { additionalProperties: true },
);

export const checkpoint = objectSchema(
  {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    status: stringEnum(["pending", "passed", "failed", "expired"]),
    type: stringEnum(["ci", "approval", "deploy", "external", "timer"]),
    createdAt: { type: "string" },
    resolvedAt: { type: "string" },
    resolvedBy: { type: "string" },
    result: { description: "Opaque checkpoint result payload" },
    expiresAt: { type: "string" },
    linkedActionIds: stringArray,
  },
  ["id", "name", "description", "status", "type", "createdAt", "linkedActionIds"],
  { additionalProperties: true },
);

export const sentinel = objectSchema(
  {
    id: { type: "string" },
    name: { type: "string" },
    type: stringEnum([
      "webhook",
      "timer",
      "threshold",
      "pattern",
      "approval",
      "custom",
    ]),
    status: stringEnum(["watching", "triggered", "cancelled", "expired"]),
    config: { type: "object", additionalProperties: true },
    result: { description: "Opaque sentinel result payload" },
    createdAt: { type: "string" },
    triggeredAt: { type: "string" },
    expiresAt: { type: "string" },
    linkedActionIds: stringArray,
    escalatedAt: { type: "string" },
  },
  ["id", "name", "type", "status", "config", "createdAt", "linkedActionIds"],
  { additionalProperties: true },
);

export const sketch = objectSchema(
  {
    id: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    status: stringEnum(["active", "promoted", "discarded"]),
    actionIds: stringArray,
    project: { type: "string" },
    createdAt: { type: "string" },
    expiresAt: { type: "string" },
    promotedAt: { type: "string" },
    discardedAt: { type: "string" },
  },
  ["id", "title", "description", "status", "actionIds", "createdAt", "expiresAt"],
  { additionalProperties: true },
);

export const crystal = objectSchema(
  {
    id: { type: "string" },
    narrative: { type: "string" },
    keyOutcomes: stringArray,
    filesAffected: stringArray,
    lessons: stringArray,
    sourceActionIds: stringArray,
    sessionId: { type: "string" },
    project: { type: "string" },
    createdAt: { type: "string" },
  },
  [
    "id",
    "narrative",
    "keyOutcomes",
    "filesAffected",
    "lessons",
    "sourceActionIds",
    "createdAt",
  ],
  { additionalProperties: true },
);

export const facet = objectSchema(
  {
    id: { type: "string" },
    targetId: { type: "string" },
    targetType: stringEnum(["action", "memory", "observation"]),
    dimension: { type: "string" },
    value: { type: "string" },
    createdAt: { type: "string" },
  },
  ["id", "targetId", "targetType", "dimension", "value", "createdAt"],
  { additionalProperties: true },
);

export const lesson = objectSchema(
  {
    id: { type: "string" },
    content: { type: "string" },
    context: { type: "string" },
    confidence: { type: "number" },
    reinforcements: { type: "number" },
    source: stringEnum(["crystal", "manual", "consolidation"]),
    sourceIds: stringArray,
    project: { type: "string" },
    tags: stringArray,
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    lastReinforcedAt: { type: "string" },
    lastDecayedAt: { type: "string" },
    decayRate: { type: "number" },
    deleted: { type: "boolean" },
    score: { type: "number" },
  },
  [
    "id",
    "content",
    "context",
    "confidence",
    "reinforcements",
    "source",
    "sourceIds",
    "tags",
    "createdAt",
    "updatedAt",
    "decayRate",
  ],
  { additionalProperties: true },
);

export const insight = objectSchema(
  {
    id: { type: "string" },
    title: { type: "string" },
    content: { type: "string" },
    confidence: { type: "number" },
    reinforcements: { type: "number" },
    sourceConceptCluster: stringArray,
    sourceMemoryIds: stringArray,
    sourceLessonIds: stringArray,
    sourceCrystalIds: stringArray,
    project: { type: "string" },
    tags: stringArray,
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    lastReinforcedAt: { type: "string" },
    lastDecayedAt: { type: "string" },
    decayRate: { type: "number" },
    deleted: { type: "boolean" },
  },
  [
    "id",
    "title",
    "content",
    "confidence",
    "reinforcements",
    "sourceConceptCluster",
    "sourceMemoryIds",
    "sourceLessonIds",
    "sourceCrystalIds",
    "tags",
    "createdAt",
    "updatedAt",
    "decayRate",
  ],
  { additionalProperties: true },
);

export const memorySlot = objectSchema(
  {
    label: { type: "string" },
    content: { type: "string" },
    sizeLimit: { type: "number" },
    description: { type: "string" },
    pinned: { type: "boolean" },
    readOnly: { type: "boolean" },
    scope: stringEnum(["project", "global"]),
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  [
    "label",
    "content",
    "sizeLimit",
    "description",
    "pinned",
    "readOnly",
    "scope",
    "createdAt",
    "updatedAt",
  ],
  { additionalProperties: true },
);

export const graphNode = objectSchema(
  {
    id: { type: "string" },
    type: { type: "string" },
    name: { type: "string" },
    properties: { type: "object", additionalProperties: true },
    sourceObservationIds: stringArray,
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    aliases: stringArray,
    stale: { type: "boolean" },
  },
  ["id", "type", "name", "properties", "sourceObservationIds", "createdAt"],
  { additionalProperties: true },
);

export const graphEdge = objectSchema(
  {
    id: { type: "string" },
    type: { type: "string" },
    sourceNodeId: { type: "string" },
    targetNodeId: { type: "string" },
    weight: { type: "number" },
    sourceObservationIds: stringArray,
    createdAt: { type: "string" },
    tcommit: { type: "string" },
    tvalid: { type: "string" },
    tvalidEnd: { type: "string" },
    context: { type: "object", additionalProperties: true },
    version: { type: "number" },
    supersededBy: { type: "string" },
    isLatest: { type: "boolean" },
    stale: { type: "boolean" },
  },
  [
    "id",
    "type",
    "sourceNodeId",
    "targetNodeId",
    "weight",
    "sourceObservationIds",
    "createdAt",
  ],
  { additionalProperties: true },
);

export const teamSharedItem = objectSchema(
  {
    id: { type: "string" },
    sharedBy: { type: "string" },
    sharedAt: { type: "string" },
    type: stringEnum(["observation", "memory", "pattern"]),
    content: { description: "Shared item payload" },
    project: { type: "string" },
    visibility: stringEnum(["shared", "private"]),
  },
  ["id", "sharedBy", "sharedAt", "type", "content", "project", "visibility"],
  { additionalProperties: true },
);

export const snapshotMeta = objectSchema(
  {
    id: { type: "string" },
    commitHash: { type: "string" },
    createdAt: { type: "string" },
    message: { type: "string" },
    stats: objectSchema(
      {
        sessions: { type: "number" },
        observations: { type: "number" },
        memories: { type: "number" },
        graphNodes: { type: "number" },
      },
      ["sessions", "observations", "memories", "graphNodes"],
      { additionalProperties: true },
    ),
  },
  ["id", "commitHash", "createdAt", "message", "stats"],
  { additionalProperties: true },
);

export const commitLink = objectSchema(
  {
    sha: { type: "string" },
    shortSha: { type: "string" },
    branch: { type: "string" },
    repo: { type: "string" },
    message: { type: "string" },
    author: { type: "string" },
    authoredAt: { type: "string" },
    files: stringArray,
    sessionIds: stringArray,
    linkedAt: { type: "string" },
  },
  ["sha", "shortSha", "sessionIds", "linkedAt"],
  { additionalProperties: true },
);

export const projectProfile = objectSchema(
  {
    project: { type: "string" },
    updatedAt: { type: "string" },
    topConcepts: arraySchema(
      objectSchema(
        { concept: { type: "string" }, frequency: { type: "number" } },
        ["concept", "frequency"],
      ),
    ),
    topFiles: arraySchema(
      objectSchema(
        { file: { type: "string" }, frequency: { type: "number" } },
        ["file", "frequency"],
      ),
    ),
    conventions: stringArray,
    commonErrors: stringArray,
    recentActivity: stringArray,
    sessionCount: { type: "number" },
    totalObservations: { type: "number" },
    summary: { type: "string" },
  },
  [
    "project",
    "updatedAt",
    "topConcepts",
    "topFiles",
    "conventions",
    "commonErrors",
    "recentActivity",
    "sessionCount",
    "totalObservations",
  ],
  { additionalProperties: true },
);

export const diagnosticCheck = objectSchema(
  {
    name: { type: "string" },
    category: { type: "string" },
    status: stringEnum(["pass", "warn", "fail"]),
    message: { type: "string" },
    fixable: { type: "boolean" },
  },
  ["name", "category", "status", "message", "fixable"],
);

export const routineRun = objectSchema(
  {
    id: { type: "string" },
    routineId: { type: "string" },
    status: stringEnum(["running", "completed", "failed", "paused"]),
    startedAt: { type: "string" },
    completedAt: { type: "string" },
    actionIds: stringArray,
    stepStatus: {
      type: "object",
      additionalProperties: stringEnum(["pending", "active", "done", "failed"]),
    },
    initiatedBy: { type: "string" },
  },
  ["id", "routineId", "status", "startedAt", "actionIds", "stepStatus", "initiatedBy"],
  { additionalProperties: true },
);
