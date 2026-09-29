import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ScoutService } from './service';
import { ServiceError } from './service';

const marketplace = z.enum(['OLX', 'Allegro Lokalnie', 'Vinted']);

function text(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function toolError(error: unknown) {
  const message = error instanceof ServiceError
    ? error.message
    : error instanceof Error ? error.message : 'Internal server error';
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

export const SCOUT_MCP_TOOL_NAMES = [
  'scout_readiness',
  'scout_dashboard',
  'scout_watches',
  'scout_listings',
  'scout_listing_detail',
  'scout_watch_analytics',
  'scout_analytics',
  'scout_market_research',
  'scout_market_trend',
  'scout_search',
  'scout_queue_scan',
  'scout_connectors',
] as const;

/**
 * Register Scout's read-mostly tool surface on an MCP server. The same
 * registration is used for every Streamable HTTP request (stateless
 * per-request servers) and for in-process tests.
 */
export function registerScoutMcpTools(server: McpServer, service: ScoutService) {
  server.registerTool('scout_readiness', {
    description: 'Scout liveness report: SQLite probe, scheduler tick age, interrupted scans, migration state, and connector degradation.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text(service.readiness()); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_dashboard', {
    description: 'Deal-monitor overview: current qualifying listings, watches, connector states, and Strong+ deal counters.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text(service.dashboard()); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_watches', {
    description: 'List deal watches with learned baselines, readiness, per-variant progress, and Strong+ finding counts.',
    inputSchema: { includeArchived: z.boolean().optional().default(false).describe('Include archived watches.') },
    annotations: { readOnlyHint: true },
  }, async ({ includeArchived }) => {
    try { return text({ watches: includeArchived ? service.allWatches() : service.getWatches() }); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_listings', {
    description: 'Query the listings feed with the same filters as GET /api/listings. Defaults to a small page to keep context compact.',
    inputSchema: {
      marketplace: marketplace.optional(),
      q: z.string().max(240).optional().describe('Case-insensitive substring over title, condition, and location.'),
      watchId: z.string().min(1).max(160).optional(),
      page: z.number().int().min(1).optional().default(1),
      pageSize: z.number().int().min(1).max(50).optional().default(20),
      sort: z.enum(['newest', 'strongest', 'price']).optional().default('newest'),
      decision: z.enum(['buy', 'watch', 'pass']).optional(),
      visibility: z.enum(['visible', 'hidden', 'all']).optional().default('visible'),
    },
    annotations: { readOnlyHint: true },
  }, async (input) => {
    try { return text(service.listingsPage(input)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_listing_detail', {
    description: 'Full detail for one listing: scoring, price history, triage action, description snapshot, and verification trace.',
    inputSchema: {
      key: z.string().min(3).max(500).describe('Global marketplace listing key.'),
      watchId: z.string().min(1).max(160).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ key, watchId }) => {
    try { return text(service.listingDetail(key, watchId ?? null)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_watch_analytics', {
    description: 'Per-watch price analytics over a day-bucketed window: median/p25/p75 trend, current spread, and per-source breakdown.',
    inputSchema: {
      id: z.string().min(1).max(160),
      days: z.number().int().min(7).max(180).optional().default(30),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id, days }) => {
    try { return text(service.watchAnalytics(id, days)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_analytics', {
    description: 'Cross-watch analytics: deal overview, trend, discount distribution, leaderboard, marketplace comparison, triage, and AI quality.',
    inputSchema: {
      days: z.number().int().min(7).max(180).optional().default(30),
      watchId: z.string().min(1).max(160).optional(),
      marketplace: marketplace.optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (input) => {
    try { return text(service.analytics(input)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_market_research', {
    description: 'Market-research watches and tracked listings with probable-sale bands. Prices are asking prices, never confirmed sales.',
    inputSchema: {
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
      watchId: z.string().min(1).max(160).optional(),
      status: z.enum(['active', 'ended', 'superseded']).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (input) => {
    try { return text(service.marketResearch(input)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_market_trend', {
    description: 'Daily price trend for one research watch with the probable-sale median as reference.',
    inputSchema: {
      id: z.string().min(1).max(160),
      days: z.number().int().min(7).max(180).optional().default(90),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id, days }) => {
    try { return text(service.marketWatchTrend(id, days)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_search', {
    description: 'Live manual marketplace search (OLX, Allegro Lokalnie, Vinted) with deterministic and AI relevance filtering. Expensive: fetches live pages.',
    inputSchema: {
      query: z.string().trim().min(1).max(240),
      sources: z.array(marketplace).min(1).max(3),
      terms: z.string().max(240).optional().default(''),
      excluded: z.string().max(240).optional().default(''),
      minPrice: z.number().nonnegative().nullable().optional(),
      maxPrice: z.number().positive().nullable().optional(),
      shippingOnly: z.boolean().optional().default(false),
      condition: z.string().max(80).optional().default('Any'),
      location: z.string().max(120).optional().default(''),
      ownerType: z.enum(['private', 'business']).nullable().optional(),
      page: z.number().int().min(1).max(10).optional().default(1),
      aiRelevance: z.boolean().optional().default(true),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (input) => {
    try { return text(await service.manualSearch(input)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_queue_scan', {
    description: 'Queue a deal-watch scan now (one watch or all enabled watches). Returns immediately; results arrive via the normal scan pipeline.',
    inputSchema: { watchId: z.string().min(1).max(160).optional().describe('Omit to scan all enabled watches.') },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ watchId }) => {
    try { return text(service.queueScan(watchId)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_connectors', {
    description: 'Marketplace and notification connector health: status, latency, and last success per connector.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text({ connectors: service.getConnectors() }); } catch (error) { return toolError(error); }
  });
}

/** Build a fresh per-request MCP server bound to the given service. */
export function createScoutMcpServer(service: ScoutService) {
  const server = new McpServer(
    { name: 'scout-deal-monitor', version: process.env.SCOUT_VERSION ?? '1.0.0' },
    { capabilities: { tools: {} } },
  );
  registerScoutMcpTools(server, service);
  return server;
}
