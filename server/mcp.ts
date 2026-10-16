import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ScoutDebug } from './debug';
import type { ScoutService } from './service';
import { ServiceError } from './service';

export const MCP_DASHBOARD_LISTINGS = 20;

const marketplace = z.enum(['OLX', 'Allegro Lokalnie', 'Vinted']);

function text(payload: unknown) {
  // Compact JSON: indentation only costs the agent context tokens.
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
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
  'scout_olx_categories',
  'scout_queue_scan',
  'scout_connectors',
  'scout_price_reference',
  'scout_comparables',
  'scout_record_outcome',
] as const;

export const SCOUT_MCP_DEBUG_TOOL_NAMES = [
  'scout_debug_schema',
  'scout_debug_table',
  'scout_debug_query',
  'scout_debug_runtime',
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
    description: `Deal-monitor overview: watches, connector states, Strong+ deal counters, and the newest ${MCP_DASHBOARD_LISTINGS} feed listings (listingsTruncated is true when the feed has more). Use scout_listings to page through the full feed.`,
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      // The web dashboard carries a 500-row feed; an agent only needs the head.
      const dashboard = service.dashboard();
      return text({ ...dashboard, listings: dashboard.listings.slice(0, MCP_DASHBOARD_LISTINGS), listingsTruncated: dashboard.listings.length > MCP_DASHBOARD_LISTINGS });
    } catch (error) { return toolError(error); }
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
    description: 'Detail for one listing: scoring, triage action and a negotiation block (days listed, price drops, negotiable flag, seller and their other listings, relists). format full (default) adds price history, description snapshot and verification trace; compact leaves them out unless included. live: true makes one request to check the listing is still up at its price; sellerListings: true makes one for the seller\'s current listings. Nothing is written.',
    inputSchema: {
      key: z.string().min(3).max(500).describe('<Marketplace>:<listingId>'),
      watchId: z.string().min(1).max(160).optional(),
      format: z.enum(['full', 'compact']).optional().describe('compact drops history, description and verification trace (default full).'),
      include: z.array(z.enum(['history', 'description'])).min(1).max(2).optional().describe('compact only: add the latest 30 price points and/or the description.'),
      live: z.boolean().optional().describe('Fetch the listing now: availability, current price and description. One marketplace request.'),
      sellerListings: z.boolean().optional().describe('Fetch the seller\'s current listings from the marketplace. One request, plus the listing page when Scout has no seller id (Allegro Lokalnie).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ key, ...options }) => {
    try { return text(await service.listingDetailForAgent(key, options)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_price_reference', {
    description: 'Scout\'s learned typical used asking price for a product, from free text: matched to deal watches (with model variants) and research series. best is null unless a match has a price from 4+ samples. No marketplace fetch and no AI call.',
    inputSchema: {
      query: z.string().trim().min(1).max(240),
      sources: z.array(marketplace).min(1).max(3).optional().describe('Prefer candidates that watch these marketplaces.'),
      minPrice: z.number().nonnegative().nullable().optional().describe('Echoed in filters.requested; never narrows the distribution.'),
      maxPrice: z.number().positive().nullable().optional().describe('Echoed in filters.requested; never narrows the distribution.'),
      terms: z.string().max(240).optional().describe('Comma-separated terms the product must also have.'),
      excluded: z.string().max(240).optional().describe('Comma-separated terms that rule a candidate out.'),
      include: z.array(z.enum(['watch', 'research'])).min(1).optional(),
      limit: z.number().int().min(1).max(5).optional().describe('Matches to return (default 5).'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (input) => {
    try { return text(service.priceReference(input)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_comparables', {
    description: 'Other active listings of the same item as one listing: same watch and model variant, same condition class (new, used or damaged), seen by a scan within the last 12 h or two scan intervals. Cheapest first, with their median and how far this listing sits from it. Database only; asking prices.',
    inputSchema: {
      listingKey: z.string().min(3).max(500).describe('<Marketplace>:<listingId>'),
      watchId: z.string().min(1).max(160).optional().describe('Place the listing in this watch instead of its most recent one.'),
      limit: z.number().int().min(1).max(10).optional().describe('Comparables to return (default and max 10); count and median cover all of them.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (input) => {
    try { return text(service.comparables(input)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_record_outcome', {
    description: 'Record how one of your negotiations ended: asking price, final price and outcome. negotiationId is the idempotency key: recording it again updates the same outcome, and optional fields left out keep their stored values. Kept apart from every asking-price statistic; scout_price_reference reports it under outcomes as the final price\'s share of asking. PLN only.',
    inputSchema: {
      negotiationId: z.string().trim().min(1).max(160).describe('The caller\'s own negotiation id.'),
      listingKey: z.string().min(3).max(500).describe('<Marketplace>:<listingId>'),
      outcome: z.enum(['agreed', 'lost', 'abandoned', 'expired']),
      asking: z.number().positive().max(10_000_000).describe('Asking price when the negotiation started, PLN.'),
      price: z.number().positive().max(10_000_000).nullable().optional().describe('Final agreed price, PLN; required when agreed.'),
      role: z.enum(['buy', 'sell']).optional().describe('Default buy.'),
      rounds: z.number().int().min(0).max(1000).optional().describe('Offers exchanged.'),
      date: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/).optional().describe('YYYY-MM-DD; default today.'),
      note: z.string().max(1000).optional(),
      currency: z.string().trim().max(8).optional().describe('Only PLN is accepted.'),
      watchId: z.string().min(1).max(160).optional().describe('File it under this watch instead of the one the listing belongs to.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (input) => {
    try { return text(service.recordOutcome(input)); } catch (error) { return toolError(error); }
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
      ownerType: z.enum(['private', 'business']).nullable().optional(),
      olxCategoryId: z.number().int().positive().optional().describe('OLX only: search one category; ids come from scout_olx_categories.'),
      page: z.number().int().min(1).max(10).optional().default(1),
      aiRelevance: z.boolean().optional().default(true),
      verificationChecks: z.array(z.object({ text: z.string().trim().min(1).max(120), mode: z.enum(['require', 'exclude']) })).max(8).optional()
        .describe('Jev reads each result: exclude hides near-certain matches; require-confirmed results come back with jevCheck "passed".'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ olxCategoryId, ...input }) => {
    try { return text(await service.manualSearch({ ...input, olxCategory: olxCategoryId ? { id: olxCategoryId, label: String(olxCategoryId), path: '' } : null })); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_olx_categories', {
    description: 'OLX categories matching a query, with hit counts (e.g. "rtx 3070" → Karty graficzne · 84, Laptopy · 231). Use an id to scope scout_search. One live metadata request; no offers are fetched.',
    inputSchema: { query: z.string().trim().min(1).max(240) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ query }) => {
    try { return text({ categories: await service.olxCategories(query) }); } catch (error) { return toolError(error); }
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

/**
 * Read-only database introspection for development: schema, raw table rows,
 * arbitrary read-only SQL, and runtime state. Mirrors /api/debug/*.
 */
export function registerScoutDebugMcpTools(server: McpServer, debug: ScoutDebug) {
  server.registerTool('scout_debug_schema', {
    description: 'Debug: every SQLite table and view with columns, indexes, and row counts, plus database file size and applied migrations. Start here before writing scout_debug_query SQL.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text(debug.schema()); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_debug_table', {
    description: 'Debug: raw rows from one table, newest first by rowid unless orderBy is given. Encrypted credentials are redacted and BLOBs are summarized by size.',
    inputSchema: {
      table: z.string().min(1).max(120),
      limit: z.number().int().min(1).max(1000).optional().default(50),
      offset: z.number().int().min(0).optional().default(0),
      orderBy: z.string().min(1).max(120).optional(),
      direction: z.enum(['asc', 'desc']).optional().default('desc'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ table, ...options }) => {
    try { return text(debug.tableRows(table, options)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_debug_query', {
    description: 'Debug: run one read-only SQL statement (SELECT, WITH, VALUES, EXPLAIN, or PRAGMA) against the live SQLite database on a read-only connection, stopped after 5 seconds. Use ? placeholders with params.',
    inputSchema: {
      sql: z.string().min(1).max(20_000),
      params: z.array(z.union([z.string(), z.number(), z.null()])).max(100).optional().default([]),
      maxRows: z.number().int().min(1).max(5000).optional().default(200),
    },
    annotations: { readOnlyHint: true },
  }, async ({ sql, params, maxRows }) => {
    try { return text(await debug.query(sql, params, maxRows)); } catch (error) { return toolError(error); }
  });

  server.registerTool('scout_debug_runtime', {
    description: 'Debug: process uptime, memory, Node version, non-secret environment configuration, readiness, settings, and the in-memory log buffer.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text(debug.runtime()); } catch (error) { return toolError(error); }
  });
}

/** Build a fresh per-request MCP server bound to the given service. */
export function createScoutMcpServer(service: ScoutService, debug: ScoutDebug | null = null) {
  const server = new McpServer(
    { name: 'scout-deal-monitor', version: process.env.SCOUT_VERSION ?? '1.0.0' },
    { capabilities: { tools: {} } },
  );
  registerScoutMcpTools(server, service);
  if (debug) registerScoutDebugMcpTools(server, debug);
  return server;
}
