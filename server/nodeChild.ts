// Short-lived Node child processes for SQLite work that must not block the
// event loop: debug queries and snapshots, the improvement export, backups.
import { spawn } from 'node:child_process';

/**
 * Run `script` in a short-lived Node child that reads `payload` as JSON on
 * stdin and prints one JSON result on stdout, so slow SQLite work cannot
 * block Scout's event loop. The child is killed at the deadline, when its
 * output passes maxOutputBytes, or when `signal` aborts.
 */
export function runNodeChild<T>(script: string, payload: object, options: {
  timeoutMs: number;
  maxOutputBytes: number;
  errors: { timeout: () => Error; tooLarge: () => Error; noResult: () => Error; aborted?: () => Error };
  signal?: AbortSignal;
}): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const aborted = options.errors.aborted ?? (() => new Error('The request was cancelled'));
    if (options.signal?.aborted) { reject(aborted()); return; }
    // Keep flags such as --experimental-sqlite that node:sqlite needs on older Node 22.
    const flags = process.execArgv.filter((flag) => flag.startsWith('--experimental'));
    const child = spawn(process.execPath, [...flags, '--no-warnings', '--max-old-space-size=256', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    const kill = (error: Error) => { if (!failure) { failure = error; child.kill('SIGKILL'); } };
    const timer = setTimeout(() => kill(options.errors.timeout()), options.timeoutMs);
    const onAbort = () => kill(aborted());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const settle = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes) kill(options.errors.tooLarge());
      else chunks.push(chunk);
    });
    child.stderr.resume();
    // A child killed before it read its input closes stdin under us.
    child.stdin.on('error', () => {});
    child.on('error', (error) => { settle(); reject(error); });
    child.on('close', () => {
      settle();
      if (failure) { reject(failure); return; }
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); } catch { reject(options.errors.noResult()); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
