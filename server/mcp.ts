import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { watchGroupsInputSchema } from './watchGroups';

const DEFAULT_API_URL = 'http://127.0.0.1:3001';
const REQUEST_TIMEOUT_MS = 120_000;

const marketplace = z.enum(['OLX', 'Allegro Lokalnie', 'Vinted']);
const marketplaceSources = z.array(marketplace).min(1).max(3);
const resourceId = z.string().trim().min(1).max(160);
const listingKey = z.string().min(3).max(500);
const watchGroups = watchGroupsInputSchema.describe(
  'Model groups that split one search into separately scored models (e.g. 13 mini / 13 / 13 Pro). Each listing is scored only against its own group\'s typical price. '
  + '`terms` are comma-separated words that must all appear in the title as whole words, with `|` for alternatives (`pro max|promax`); `excluded` uses the same syntax. '
  + 'The most specific match wins, so a base group needs no exclusions. Listings matching no group are kept but not scored. '
  + 'A group\'s typical needs 10 of its own listings; alerts also need 30 across all groups.',
);

export interface ScoutMcpOptions {
  apiUrl?: string;
  allowWrites?: boolean;
  fetchImpl?: typeof fetch;
}

type ToolCallbackResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

function text(value: unknown): ToolCallbackResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): ToolCallbackResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `Scout request failed: ${message}` }], isError: true };
}

function queryString(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export class ScoutApi {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch) {}

  async request<T = unknown>(method: string, path: string, body?: unknown, tolerateStatus: number[] = []): Promise<{ status: number; data: T }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok && !tolerateStatus.includes(response.status)) {
      throw new Error(data.error ?? `HTTP ${response.status}`);
    }
    return { status: response.status, data };
  }
}

export function createScoutMcpServer(options: ScoutMcpOptions = {}) {
  const baseUrl = (options.apiUrl ?? process.env.SCOUT_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const allowWrites = options.allowWrites ?? /^(?:1|true|yes)$/i.test(process.env.SCOUT_MCP_ALLOW_WRITES ?? '');
  const api = new ScoutApi(baseUrl, options.fetchImpl ?? fetch);

  const server = new McpServer({ name: 'scout', version: '1.0.0' });

  function registerRead(name: string, description: string, inputSchema: z.ZodRawShape | undefined, handler: ToolHandler) {
    server.registerTool(
      name,
      { description, inputSchema: inputSchema as never, annotations: { readOnlyHint: true, openWorldHint: true } },
      (async (args: Record<string, unknown> = {}) => {
        try {
          return text(await handler(args));
        } catch (error) {
          return errorResult(error);
        }
      }) as never,
    );
  }

  function registerWrite(name: string, description: string, inputSchema: z.ZodRawShape, handler: ToolHandler, destructive = false) {
    if (!allowWrites) return;
    server.registerTool(
      name,
      { description, inputSchema: inputSchema as never, annotations: { readOnlyHint: false, destructiveHint: destructive, openWorldHint: true } },
      (async (args: Record<string, unknown> = {}) => {
        try {
          return text(await handler(args));
        } catch (error) {
          return errorResult(error);
        }
      }) as never,
    );
  }

  async function readResource(uri: string, loader: () => Promise<unknown>): Promise<ReadResourceResult> {
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await loader(), null, 2) }] };
  }

  // ---- Read-only tools -------------------------------------------------

  registerRead('get_status', 'Liveness and readiness of the Scout API, including the SQLite probe, scheduler age, interrupted scans, migrations, and connector degradation.', undefined, async () => {
    const health = await api.request('GET', '/api/health', undefined, [503]);
    const ready = await api.request('GET', '/api/ready', undefined, [503]);
    return { health: health.data, ready: ready.data };
  });

  registerRead('get_dashboard', 'Dashboard counters and recent deal listings.', undefined, async () => (await api.request('GET', '/api/dashboard')).data);

  registerRead('list_watches', 'List deal watches (optionally including archived ones). Grouped watches include `groups` (with the `key`s to pass back to update_watch), per-group baseline progress in `groupStats`, and `unassignedSamples`.', { includeArchived: z.boolean().optional() }, async (args) => (
    await api.request('GET', `/api/watches${queryString({ includeArchived: args.includeArchived as boolean | undefined })}`)
  ).data);

  registerRead(
    'list_listings',
    'Paginated, filterable listing feed across all watches. On grouped watches each listing carries `group` (null = matched no group, not scored) and `groupSource` (rule, jev, or manual); its typical price comes from that group.',
    { page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(500).optional(), marketplace: marketplace.optional(), q: z.string().max(240).optional(), watchId: resourceId.optional() },
    async (args) => (await api.request('GET', `/api/listings${queryString(args as Record<string, string | number | boolean | undefined>)}`)).data,
  );

  registerRead('get_listing_detail', 'Full detail for one listing key, including score breakdown and price history. For grouped watches it also returns the listing\'s group and the watch\'s `groups`, for use with set_listing_group.', { key: z.string().min(3).max(500), watchId: resourceId.optional() }, async (args) => (
    await api.request('GET', `/api/listing-detail${queryString({ key: args.key as string, watchId: args.watchId as string | undefined })}`)
  ).data);

  registerRead('get_listing_action', 'Saved decision, note, and hidden state for a listing key.', { key: z.string().min(3).max(500) }, async (args) => (
    await api.request('GET', `/api/listing-actions${queryString({ key: args.key as string })}`)
  ).data);

  registerRead(
    'search_listings',
    'Run a live manual marketplace search (OLX / Allegro Lokalnie / Vinted) and get scored results. This performs real network scans.',
    {
      query: z.string().trim().min(1).max(240),
      terms: z.string().max(240).optional(),
      excluded: z.string().max(240).optional(),
      sources: marketplaceSources,
      minPrice: z.number().nonnegative().nullable().optional(),
      maxPrice: z.number().positive().nullable().optional(),
      shippingOnly: z.boolean().optional(),
      condition: z.string().max(80).optional(),
      location: z.string().max(120).optional(),
    },
    async (args) => (await api.request('POST', '/api/search', args)).data,
  );

  registerRead('get_watch_analytics', 'Analytics for a single watch over a window of days (7-180).', { watchId: resourceId, days: z.number().int().min(7).max(180).optional() }, async (args) => (
    await api.request('GET', `/api/watches/${encodeURIComponent(args.watchId as string)}/analytics${queryString({ days: args.days as number | undefined })}`)
  ).data);

  registerRead('get_analytics', 'Aggregate analytics, optionally filtered by watch or marketplace.', { days: z.number().int().min(7).max(180).optional(), watchId: resourceId.optional(), marketplace: marketplace.optional() }, async (args) => (
    await api.request('GET', `/api/analytics${queryString(args as Record<string, string | number | boolean | undefined>)}`)
  ).data);

  registerRead(
    'list_market_research',
    'Research (market) watch history: listings with status active, ended, or superseded.',
    { page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(400).optional(), watchId: resourceId.optional(), status: z.enum(['active', 'ended', 'superseded']).optional() },
    async (args) => (await api.request('GET', `/api/market-watches${queryString(args as Record<string, string | number | boolean | undefined>)}`)).data,
  );

  registerRead('get_market_trend', 'Price-trend series for a research watch (median asking price with p25-p75 band).', { watchId: resourceId, days: z.number().int().min(7).max(180).optional() }, async (args) => (
    await api.request('GET', `/api/market-watches/${encodeURIComponent(args.watchId as string)}/trend${queryString({ days: args.days as number | undefined })}`)
  ).data);

  registerRead('get_market_listing_history', 'Stored price-observation points for one research listing.', { id: z.number().int().min(1) }, async (args) => (
    await api.request('GET', `/api/market-listings/${args.id as number}/history`)
  ).data);

  registerRead('get_market_listing_snapshot', 'Preserved listing snapshot (description and image ids) for one research listing.', { id: z.number().int().min(1) }, async (args) => (
    await api.request('GET', `/api/market-listings/${args.id as number}/snapshot`)
  ).data);

  registerRead('list_notifications', 'Paginated notification delivery history.', { page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(200).optional() }, async (args) => (
    await api.request('GET', `/api/notifications${queryString(args as Record<string, string | number | boolean | undefined>)}`)
  ).data);

  registerRead('list_connector_runs', 'Paginated connector scan history.', { page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(200).optional() }, async (args) => (
    await api.request('GET', `/api/connector-runs${queryString(args as Record<string, string | number | boolean | undefined>)}`)
  ).data);

  registerRead('get_connectors', 'Connector health and degradation state per marketplace.', undefined, async () => (await api.request('GET', '/api/connectors')).data);

  registerRead('get_logs', 'Recent Scout log entries.', undefined, async () => (await api.request('GET', '/api/logs')).data);

  registerRead('get_settings', 'Current Scout settings with secrets masked.', undefined, async () => (await api.request('GET', '/api/settings')).data);

  // ---- Mutating tools (require SCOUT_MCP_ALLOW_WRITES) -----------------

  registerWrite(
    'create_watch',
    'Create a deal watch. Watches are scanned on the configured interval and can send alerts. Pass `groups` when one search covers several models with different prices.',
    {
      name: z.string().trim().min(1).max(120),
      query: z.string().trim().min(1).max(240),
      terms: z.string().max(240).optional(),
      excluded: z.string().max(240).optional(),
      sources: marketplaceSources,
      location: z.string().max(120).optional(),
      condition: z.string().max(80).optional(),
      interval: z.number().int().min(5).max(1440).optional(),
      exactUrls: z.array(z.string().url()).max(20).optional(),
      sensitivity: z.number().min(0.6).max(1.6).optional(),
      shippingOnly: z.boolean().optional(),
      typoVariants: z.boolean().optional(),
      aiRelevance: z.boolean().optional(),
      referenceMarketWatchId: z.string().trim().max(160).nullable().optional(),
      minPrice: z.number().nonnegative().nullable().optional(),
      maxPrice: z.number().positive().nullable().optional(),
      groups: watchGroups.optional(),
    },
    async (args) => (await api.request('POST', '/api/watches', args)).data,
  );

  registerWrite(
    'update_watch',
    'Update fields on an existing deal watch, including enabling, archiving, or changing its query. '
      + '`groups` replaces the whole group list and immediately re-sorts the watch\'s stored listings: include each existing group\'s `key` (from list_watches) so renamed groups keep their history. '
      + 'Manual listing picks survive while their group exists; AI picks are re-evaluated on the next scan. Pass [] to remove grouping.',
    {
      watchId: resourceId,
      name: z.string().trim().min(1).max(120).optional(),
      query: z.string().trim().min(1).max(240).optional(),
      terms: z.string().max(240).optional(),
      excluded: z.string().max(240).optional(),
      sources: marketplaceSources.optional(),
      location: z.string().max(120).optional(),
      condition: z.string().max(80).optional(),
      exactUrls: z.array(z.string().url()).max(20).optional(),
      sensitivity: z.number().min(0.6).max(1.6).optional(),
      enabled: z.boolean().optional(),
      interval: z.number().int().min(5).max(1440).optional(),
      shippingOnly: z.boolean().optional(),
      aiRelevance: z.boolean().optional(),
      typoVariants: z.boolean().optional(),
      referenceMarketWatchId: z.string().trim().max(160).nullable().optional(),
      archived: z.boolean().optional(),
      minPrice: z.number().nonnegative().nullable().optional(),
      maxPrice: z.number().positive().nullable().optional(),
      groups: watchGroups.optional(),
    },
    async ({ watchId, ...patch }) => (await api.request('PATCH', `/api/watches/${encodeURIComponent(watchId as string)}`, patch)).data,
  );

  registerWrite('delete_watch', 'Permanently delete a deal watch and its listings.', { watchId: resourceId }, async (args) => (
    await api.request('DELETE', `/api/watches/${encodeURIComponent(args.watchId as string)}`)
  ).data, true);

  registerWrite(
    'set_listing_group',
    'Move a listing of a grouped watch into one of its groups, overriding the rules and AI; the listing is re-scored against that group immediately. '
      + 'Pass groupKey null to return it to automatic assignment. Group keys come from list_watches or get_listing_detail.',
    { key: listingKey, watchId: resourceId, groupKey: z.string().trim().min(1).max(60).nullable() },
    async (args) => (await api.request('PUT', '/api/listing-group', { key: args.key, watchId: args.watchId, groupKey: args.groupKey })).data,
  );

  registerWrite('queue_scan', 'Queue an immediate scan, for one watch or all enabled watches.', { watchId: resourceId.optional() }, async (args) => (
    await api.request('POST', '/api/scans', args.watchId ? { watchId: args.watchId } : {})
  ).data);

  registerWrite(
    'set_listing_action',
    'Record a decision (buy, watch, pass), a note, and/or hide a listing. Omit decision to leave it unchanged.',
    { key: z.string().min(3).max(500), decision: z.enum(['buy', 'watch', 'pass']).nullable().optional(), note: z.string().max(2000).optional(), hidden: z.boolean().optional() },
    async (args) => (await api.request('PATCH', '/api/listing-actions', { decision: null, note: '', hidden: false, ...args })).data,
  );

  registerWrite(
    'create_market_watch',
    'Create a research watch for market price tracking.',
    {
      name: z.string().trim().min(1).max(120),
      query: z.string().trim().min(1).max(240),
      terms: z.string().max(240).optional(),
      excluded: z.string().max(240).optional(),
      location: z.string().max(120).optional(),
      condition: z.string().max(80).optional(),
      sources: marketplaceSources,
      intervalHours: z.number().int().min(6).max(168).optional(),
      minPrice: z.number().nonnegative().nullable().optional(),
      maxPrice: z.number().positive().nullable().optional(),
      shippingOnly: z.boolean().optional(),
      typoVariants: z.boolean().optional(),
    },
    async (args) => (await api.request('POST', '/api/market-watches', args)).data,
  );

  registerWrite(
    'update_market_watch',
    'Update a research (market) watch.',
    {
      watchId: resourceId,
      name: z.string().trim().min(1).max(120).optional(),
      query: z.string().trim().min(1).max(240).optional(),
      enabled: z.boolean().optional(),
      intervalHours: z.number().int().min(6).max(168).optional(),
      terms: z.string().max(240).optional(),
      excluded: z.string().max(240).optional(),
      location: z.string().max(120).optional(),
      condition: z.string().max(80).optional(),
      sources: marketplaceSources.optional(),
      minPrice: z.number().nonnegative().nullable().optional(),
      maxPrice: z.number().positive().nullable().optional(),
      shippingOnly: z.boolean().optional(),
      typoVariants: z.boolean().optional(),
    },
    async ({ watchId, ...patch }) => (await api.request('PATCH', `/api/market-watches/${encodeURIComponent(watchId as string)}`, patch)).data,
  );

  registerWrite('delete_market_watch', 'Delete a research watch and its preserved listings.', { watchId: resourceId }, async (args) => (
    await api.request('DELETE', `/api/market-watches/${encodeURIComponent(args.watchId as string)}`)
  ).data, true);

  registerWrite('scan_market_watch', 'Queue an immediate research scan for one market watch.', { watchId: resourceId }, async (args) => (
    await api.request('POST', `/api/market-watches/${encodeURIComponent(args.watchId as string)}/scan`)
  ).data);

  registerWrite('capture_market_listing_snapshot', 'Capture or refresh the preserved snapshot of a research listing now.', { id: z.number().int().min(1) }, async (args) => (
    await api.request('POST', `/api/market-listings/${args.id as number}/snapshot`)
  ).data);

  // ---- Resources -------------------------------------------------------

  server.registerResource('status', 'scout://status', { title: 'Scout readiness', description: 'Current Scout readiness report.', mimeType: 'application/json' }, () => (
    readResource('scout://status', async () => (await api.request('GET', '/api/ready', undefined, [503])).data)
  ));

  server.registerResource('dashboard', 'scout://dashboard', { title: 'Scout dashboard', description: 'Current dashboard counters and recent deals.', mimeType: 'application/json' }, () => (
    readResource('scout://dashboard', async () => (await api.request('GET', '/api/dashboard')).data)
  ));

  return { server, api, allowWrites, baseUrl };
}

async function main() {
  const { server, allowWrites, baseUrl } = createScoutMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`scout-mcp connected to ${baseUrl} (writes ${allowWrites ? 'enabled' : 'disabled'})`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error('scout-mcp failed to start:', error);
    process.exit(1);
  });
}
