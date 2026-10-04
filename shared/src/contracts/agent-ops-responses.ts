/**
 * Shared Zod schemas for agent-ops API response contracts.
 *
 * Both agent-ops (producer) and galaxy-cli (consumer) MUST reference
 * these schemas so that a response shape mismatch becomes a build-time
 * or test-time failure instead of a silent runtime break.
 *
 * Motivated by: CLI `agent logs` breakage when agent-ops changed its
 * response format without updating the CLI.
 */

import { z } from "zod";

export const LogEntrySchema = z.object({
  timestamp: z
    .string()
    .datetime({ offset: true, message: "timestamp must be ISO-8601 with offset" }),
  level: z.enum(["info", "warn", "error"]),
  source: z.string().min(1),
  message: z.string(),
  run_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const LogsResponseSchema = z.object({
  logs: z.array(LogEntrySchema),
  total: z.number().int().nonnegative(),
});

export type LogEntry = z.infer<typeof LogEntrySchema>;
export type LogsResponse = z.infer<typeof LogsResponseSchema>;

// Distributed trace + pod runtime-metrics contracts.

export const TraceSpanSchema = z.object({
  spanId: z.string().min(1),
  parentSpanId: z.string().optional(),
  operationName: z.string(),
  serviceName: z.string(),
  startTimeUnixNano: z.string(),
  durationMs: z.number().nonnegative(),
});

export const TraceResponseSchema = z.object({
  traceId: z.string().nullable(),
  spans: z.array(TraceSpanSchema),
});

export const PodResourceSampleSchema = z.object({
  pod: z.string(),
  cpuCores: z.number().nonnegative(),
  memoryBytes: z.number().nonnegative(),
});

export const PodMetricsResponseSchema = z.object({
  samples: z.array(PodResourceSampleSchema),
});

export type TraceSpan = z.infer<typeof TraceSpanSchema>;
export type TraceResponse = z.infer<typeof TraceResponseSchema>;
export type PodResourceSample = z.infer<typeof PodResourceSampleSchema>;
export type PodMetricsResponse = z.infer<typeof PodMetricsResponseSchema>;
