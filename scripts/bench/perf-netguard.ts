/**
 * Blocks every non-loopback network call in the benchmark process: fetch,
 * http/https requests, raw TCP/TLS connects and DNS lookups. perf.ts installs
 * it before importing any server module, so a code path that would reach a
 * marketplace, OpenRouter, Discord or ntfy fails fast and is counted instead.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export const blockedAttempts: Array<{ kind: string; detail: string }> = [];

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

function block(kind: string, detail: string): never {
  blockedAttempts.push({ kind, detail: detail.slice(0, 200) });
  throw new Error(`bench: network disabled (${kind} ${detail.slice(0, 120)})`);
}

function hostOf(target: unknown): string {
  if (typeof target === 'string') {
    try { return new URL(target).hostname; } catch { return target; }
  }
  if (target instanceof URL) return target.hostname;
  if (target && typeof target === 'object') {
    const options = target as { host?: string; hostname?: string; path?: string };
    if (options.path && !options.host && !options.hostname) return 'localhost'; // unix socket / IPC
    return String(options.hostname ?? options.host ?? 'localhost');
  }
  return 'unknown';
}

let installed = false;

export function installNetGuard() {
  if (installed) return;
  installed = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!LOOPBACK.test(hostOf(url))) block('fetch', url);
    return realFetch(input, init);
  }) as typeof fetch;
  for (const [name, module] of [['http', http], ['https', https]] as const) {
    const mod = module as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ['request', 'get']) {
      const original = mod[method];
      mod[method] = (...args: unknown[]) => {
        if (!LOOPBACK.test(hostOf(args[0]))) block(`${name}.${method}`, String(hostOf(args[0])));
        return original.apply(module, args);
      };
    }
  }
  const netModule = net as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['connect', 'createConnection']) {
    const original = netModule[method];
    netModule[method] = (...args: unknown[]) => {
      const first = args[0];
      const host = typeof first === 'number' ? String(args[1] ?? 'localhost') : hostOf(first);
      if (!LOOPBACK.test(host)) block(`net.${method}`, host);
      return original.apply(net, args);
    };
  }
  const tlsModule = tls as unknown as Record<string, (...args: unknown[]) => unknown>;
  const tlsConnect = tlsModule.connect;
  tlsModule.connect = (...args: unknown[]) => {
    const first = args[0];
    const host = typeof first === 'number' ? String(args[1] ?? 'localhost') : hostOf(first);
    if (!LOOPBACK.test(host)) block('tls.connect', host);
    return tlsConnect.apply(tls, args);
  };
  const dnsModule = dns as unknown as Record<string, unknown>;
  const lookup = dns.lookup;
  dnsModule.lookup = (hostname: string, ...rest: unknown[]) => {
    if (!LOOPBACK.test(hostname)) block('dns.lookup', hostname);
    return (lookup as (...args: unknown[]) => unknown)(hostname, ...rest);
  };
  const promises = dns.promises as unknown as Record<string, (...args: unknown[]) => unknown>;
  const promiseLookup = promises.lookup;
  promises.lookup = (...args: unknown[]) => {
    const hostname = String(args[0]);
    if (!LOOPBACK.test(hostname)) return Promise.reject(new Error(`bench: network disabled (dns ${hostname})`)).finally(() => blockedAttempts.push({ kind: 'dns.promises.lookup', detail: hostname }));
    return promiseLookup.apply(dns.promises, args);
  };
}
