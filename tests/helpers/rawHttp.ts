/**
 * A raw `node:http` client for tests that must control headers `fetch` will not
 * let a caller set (`Host`) or must send a body with no Content-Length (chunked).
 * Used by the S1, S4 and parse-pdf tests.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly text: string;
  readonly json: any;
}

export interface RawRequest {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  /** Object bodies are sent as JSON. A string is sent as-is. */
  readonly body?: unknown;
  /** Send the body in several chunks with no Content-Length. */
  readonly chunked?: boolean;
}

export interface TestServer {
  readonly port: number;
  request(req: RawRequest): Promise<RawResponse>;
  close(): Promise<void>;
}

/**
 * Listen on an ephemeral loopback port first, then build the app. Some guards
 * need the port number at construction, so the order is create, listen, read
 * port, build, attach.
 */
export async function startTestServer(build: (port: number) => Express | Promise<Express>): Promise<TestServer> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const app = await build(port);
  server.on('request', app);

  return {
    port,
    request: req =>
      new Promise<RawResponse>((resolve, reject) => {
        const payload =
          req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const headers: Record<string, string> = {
          Host: `127.0.0.1:${port}`,
          ...(payload !== undefined && typeof req.body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...req.headers,
        };
        if (payload !== undefined && req.chunked !== true) {
          headers['Content-Length'] = String(Buffer.byteLength(payload));
        }
        const clientReq = http.request(
          { host: '127.0.0.1', port, method: req.method ?? 'GET', path: req.path, headers },
          res => {
            const parts: Buffer[] = [];
            res.on('data', chunk => parts.push(chunk as Buffer));
            res.on('end', () => {
              const text = Buffer.concat(parts).toString('utf8');
              let json: any;
              try {
                json = JSON.parse(text);
              } catch {
                json = undefined;
              }
              resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
            });
          }
        );
        clientReq.on('error', reject);
        if (payload !== undefined) {
          if (req.chunked === true) {
            const half = Math.ceil(payload.length / 2);
            clientReq.write(payload.slice(0, half));
            clientReq.write(payload.slice(half));
          } else {
            clientReq.write(payload);
          }
        }
        clientReq.end();
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}
