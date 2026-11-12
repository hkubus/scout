import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';

// The Compose healthcheck polls /api/ready every 30 s, so successful probes
// would otherwise be most of the request log.
const PROBE_ROUTES = new Set(['/api/health', '/api/ready']);

/**
 * Writes one line per request when it completes (method, URL, status, ms and
 * client IP) instead of Fastify's "incoming request" and "request completed"
 * pair. Health and readiness probes are logged only when they fail.
 */
export class ScoutLogController extends LogController {
  override incomingRequest(): void {}

  // The completion line already carries the method, URL and 404 status.
  override routeNotFound(): void {}

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    const failed = Boolean(error) || reply.statusCode >= 400;
    if (!failed && PROBE_ROUTES.has(request.routeOptions.url ?? '')) return;
    const line = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      ms: Math.round(reply.elapsedTime * 10) / 10,
      // request.ip follows trustProxy, so behind the proxy it is the real client.
      ip: request.ip,
      ...(error ? { err: error } : {}),
    };
    if (error || reply.statusCode >= 500) reply.log.error(line, 'request completed');
    else reply.log.info(line, 'request completed');
  }
}
