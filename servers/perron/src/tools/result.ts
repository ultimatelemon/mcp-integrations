import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AmbiguousStation,
  NotFound,
  RateLimited,
  StationNotFound,
  UpstreamError
} from '../errors.ts';
import type { Logger } from '../lib/logger.ts';

export function ok(
  summary: string,
  data: Record<string, unknown>
): CallToolResult {
  return {
    // The JSON goes in content too: not every client hands structuredContent to the model.
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(data) }
    ],
    structuredContent: data
  };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function errorResult(error: unknown, logger: Logger): CallToolResult {
  if (
    error instanceof StationNotFound ||
    error instanceof AmbiguousStation ||
    error instanceof NotFound
  ) {
    return fail(error.message);
  }
  if (error instanceof RateLimited) {
    return fail(
      `The NS API rate limit is reached. Try again in ${String(Math.ceil(error.retryAfterMs / 1000))} seconds.`
    );
  }
  if (error instanceof UpstreamError) {
    logger.warn(
      { service: error.service, status: error.status, err: error.message },
      'upstream error'
    );
    return fail(
      error.status === 404
        ? `${error.service} has no data for this request.`
        : `The ${error.service} API returned an error (${String(error.status)}). ${error.message}`
    );
  }
  logger.error(
    { err: error instanceof Error ? error.stack : String(error) },
    'tool failed'
  );
  return fail('Something went wrong while handling this request.');
}

/** Runs a tool body and turns every thrown error into a readable tool error. */
export async function run(
  logger: Logger,
  body: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    return errorResult(error, logger);
  }
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;
