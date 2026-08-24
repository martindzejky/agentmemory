export type McpTextBlock = { type: "text"; text: string };

export type McpToolResultBody = {
  content: McpTextBlock[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function asStructuredObject(
  result: unknown,
  wrapArrayAs = "items",
): Record<string, unknown> {
  if (Array.isArray(result)) {
    return { [wrapArrayAs]: result };
  }
  if (result !== null && typeof result === "object") {
    return result as Record<string, unknown>;
  }
  if (typeof result === "string") {
    return { text: result };
  }
  return { value: result };
}

export function mcpToolResult(
  result: unknown,
  options?: {
    text?: string;
    pretty?: boolean;
    wrapArrayAs?: string;
  },
): McpToolResultBody {
  const pretty = options?.pretty !== false;
  const text =
    options?.text ??
    (pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result));
  return {
    content: [{ type: "text", text }],
    structuredContent: asStructuredObject(result, options?.wrapArrayAs),
  };
}

export function mcpUnavailable(message: string): McpToolResultBody {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { status: "unavailable", message },
  };
}

export function mcpToolError(message: string): McpToolResultBody {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { status: "error", message },
    isError: true,
  };
}
