import * as http from 'http';

export interface ProxyConfig {
  apiKey: string;
  /** Base URL of OpenRouter API. Defaults to https://openrouter.ai/api/v1 */
  baseUrl?: string;
  /** Called once per completed generation with the captured usage. */
  onGeneration: (g: CapturedCompletion) => void;
  /** Called with any proxy-level errors. */
  onError?: (err: Error) => void;
}

/** A chat completion processed through the proxy (usage captured). */
export interface CapturedCompletion {
  id: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    reasoning_tokens?: number;
    cost?: number;
  };
  created: number;
  finished: boolean;
}

const OR_BASE = 'https://openrouter.ai/api/v1';

/**
 * A minimal reverse proxy for https://openrouter.ai/api/v1 that records
 * per-request usage (tokens + cost) for the cost monitor.
 *
 * It forwards any path under /api/v1 (chat/completions, responses, etc.)
 * to OpenRouter, passes through streaming SSE, and parses the final usage
 * block in both streaming and non-streaming responses.
 */
export class OpenRouterProxy {
  private server: http.Server | undefined;
  private readonly cfg: ProxyConfig;

  constructor(cfg: ProxyConfig) {
    this.cfg = { baseUrl: OR_BASE, ...cfg };
  }

  /** Start listening. Returns the actual port (0 = random). */
  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      this.server.on('error', (e) => this.cfg.onError?.(e));
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server?.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
      this.server.on('error', reject);
    });
  }

  /** The base URL callers should use to hit this proxy. */
  get url(): string {
    if (!this.server) throw new Error('proxy not started');
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return `http://127.0.0.1:${port}/api/v1`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // Assemble the request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      // Read the API key: prefer proxy's own, else header passthrough
      const auth = req.headers['authorization'] || `Bearer ${this.cfg.apiKey}`;
      const headers: Record<string, string> = {
        Authorization: auth,
        'Content-Type': 'application/json',
      };
      // Forward relevant OpenRouter attribution headers if present
      const forward = ['x-title', 'http-referer', 'x-openrouter-title', 'x-openrouter-categories'];
      for (const h of forward) {
        const v = req.headers[h];
        if (v) headers[h] = Array.isArray(v) ? v[0] : v;
      }

      const target = `${this.cfg.baseUrl}${this.stripApiPrefix(req.url ?? '/')}`;
      const upstream = await fetch(target, {
        method: req.method ?? 'GET',
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        // Don't let OpenRouter wait forever
        signal: AbortSignal.timeout(300_000),
      });

      // Copy upstream headers
      res.writeHead(upstream.status, upstream.statusText ?? '', Object.fromEntries(
        [...upstream.headers.entries()].filter(([k]) => !['content-length'].includes(k.toLowerCase()))
      ));

      const isStream = (req.headers.accept || '').includes('text/event-stream') || body.toString().includes('"stream":true');

      if (isStream) {
        // SSE: forward chunks; capture final usage line
        const reader = upstream.body?.getReader();
        const textDecoder = new TextDecoder();
        let buffer = '';
        const finish = () => {
          const captured = this.parseUsageFromSse(buffer);
          if (captured) this.cfg.onGeneration(captured);
        };
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += textDecoder.decode(value, { stream: true });
              res.write(value);
            }
          } finally {
            reader.releaseLock();
            finish();
          }
        }
        res.end();
      } else {
        const upstreamText = await upstream.text();
        // Forward body (upstream already sets content-length)
        res.write(upstreamText);
        res.end();
        try {
          const captured = this.parseUsageFromJson(upstreamText);
          if (captured) this.cfg.onGeneration(captured);
        } catch {
          /* non-JSON error body — skip capture */
        }
      }
    } catch (e) {
      this.cfg.onError?.(e instanceof Error ? e : new Error(String(e)));
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'proxy error: ' + (e instanceof Error ? e.message : e) } }));
      }
    }
  }

  /** Strip a leading /api/v1 from the incoming path if present (baseUrl already includes it). */
  private stripApiPrefix(url: string): string {
    return url.replace(/^\/api\/v1(?=\/|$)/, '') || '/';
  }

  /** Parse a non-streaming JSON completion body for usage. */
  private parseUsageFromJson(text: string): CapturedCompletion | undefined {
    const obj = JSON.parse(text) as {
      id?: string;
      model?: string;
      created?: number;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
        cost?: number;
      };
    };
    if (!obj?.id || obj.id.startsWith('gen-')) return undefined; // not a completion
    const u = obj.usage;
    if (!u) return undefined;
    return {
      id: obj.id,
      model: obj.model ?? '(unknown)',
      created: obj.created ?? Math.floor(Date.now() / 1000),
      usage: {
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
        reasoning_tokens: u.completion_tokens_details?.reasoning_tokens,
        cost: u.cost,
      },
      finished: true,
    };
  }

  /** Parse SSE text for the final [DONE]/usage chunk. */
  private parseUsageFromSse(sse: string): CapturedCompletion | undefined {
    // The final usage chunk in OpenRouter SSE looks like:
    // data: {"id":"gen-...","choices":[{...}],"usage":{...},"model":"..."}
    const lines = sse.split('\n').filter((l) => l.startsWith('data:'));
    let lastWithUsage: CapturedCompletion | undefined;
    for (const line of lines) {
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const obj = JSON.parse(data);
        if (obj?.usage) {
          const u = obj.usage;
          lastWithUsage = {
            id: obj.id ?? `stream-${Date.now()}`,
            model: obj.model ?? '(unknown)',
            created: obj.created ?? Math.floor(Date.now() / 1000),
            usage: {
              prompt_tokens: u.prompt_tokens ?? 0,
              completion_tokens: u.completion_tokens ?? 0,
              total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
              reasoning_tokens: u.completion_tokens_details?.reasoning_tokens,
              cost: u.cost,
            },
            finished: true,
          };
        }
      } catch {
        /* skip malformed chunk */
      }
    }
    return lastWithUsage;
  }
}