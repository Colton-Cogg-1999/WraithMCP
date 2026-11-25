export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export function paginate<T>(items: T[], offset = 0, limit = 25): PaginatedResult<T> {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const slice = items.slice(safeOffset, safeOffset + safeLimit);
  return {
    items: slice,
    total: items.length,
    offset: safeOffset,
    limit: safeLimit,
    hasMore: safeOffset + slice.length < items.length,
  };
}

/**
 * Format an MCP tool response as compact JSON text plus MCP 2025-06-18 `structuredContent`
 * when returning a structured object payload.
 */
export function mcpTextResult(data: unknown, isError = false) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const isObject = typeof data === "object" && data !== null && !Array.isArray(data);
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    ...(!isError && isObject ? { structuredContent: data as Record<string, unknown> } : {}),
    ...(isError ? { isError: true } : {}),
  };
}
