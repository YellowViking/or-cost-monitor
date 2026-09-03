import * as vscode from 'vscode';
import { log } from './logger';

/**
 * The OpenRouter chat provider.
 *
 * It re-exposes the models configured in chatLanguageModels.json for the
 * `openrouter` vendor as a *custom* provider (`or-cost-openrouter`), so that
 * requests route through the usage-capturing proxy instead of VS Code's
 * built-in direct call.
 *
 * NOTE: This uses the PROPOSED `lm.registerLanguageModelChatProvider` API,
 * which requires Insiders + `"capabilities": { "proposedApi": [...] }`.
 */

interface ChatModelDef {
  id: string;
  name: string;
  family: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean | number;
  imageInput: boolean;
}

/** The models this provider exposes. Matches the user's deepseek-v4-flash-0731. */
const MODELS: ChatModelDef[] = [
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash 0731',
    family: 'deepseek-v4-flash',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 16_000,
    toolCalling: true,
    imageInput: true,
  },
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    family: 'glm-5.3-flash',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 16_000,
    toolCalling: true,
    imageInput: true,
  },
  {
    id: 'openai/gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    family: 'gpt-5.6-luna',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 16_000,
    toolCalling: true,
    imageInput: true,
  },
];

interface ProviderOptions {
  /** Base URL of the local proxy (http://127.0.0.1:PORT/api/v1). */
  proxyBaseUrl: string;
  /** The API key to embed (sent as Bearer). */
  apiKey: string;
}

export class OpenRouterChatProvider implements vscode.LanguageModelChatProvider {
  readonly onDidChangeLanguageModelChatInformation?: vscode.Event<void> = undefined;

  constructor(private readonly opts: ProviderOptions) {}

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    return MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      family: m.family,
      version: '1.0.0',
      maxInputTokens: m.maxInputTokens,
      maxOutputTokens: m.maxOutputTokens,
      capabilities: {
        toolCalling: m.toolCalling,
        imageInput: m.imageInput,
      },
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const body = this.buildRequestBody(model, messages, options);
    // Stream — OpenRouter's stable path for (reasoning) models; also gives the
    // proxy the final usage chunk and avoids non-streaming provider 500s.
    body.stream = true;

    await this.streamChatCompletion(body, progress, token, 2 /* retries */);
  }

  /**
   * POST a streaming chat completion to the proxy with 5xx retry/backoff.
   * Parses SSE chunks, reports text + tool-call parts progressively, and
   * logs diagnostics on failure.
   */
  private async streamChatCompletion(
    body: Record<string, unknown>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    retriesLeft: number
  ): Promise<void> {
    // --- diagnostics: log what we're sending (shape, not secrets) ---
    const bodyStr = JSON.stringify(body);
    const bodyLen = bodyStr.length;
    const messages = body.messages as Array<{ role?: string; content?: unknown }>;
    const msgSummary = messages.map((m) => {
      const c = m?.content;
      const s = Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? `str(${p.length})` : (p as { type?: string })?.type ?? typeof p)).join(',') : typeof c;
      return `${m?.role}:${s}`;
    });
    log.info(`provideLanguageModelChatResponse model=${String(body.model)} bodyLen=${bodyLen} messages=[${msgSummary.join(' | ')}] tools=${Array.isArray(body.tools) ? body.tools.length : 0} stream=true retriesLeft=${retriesLeft}`);

    const reqStart = Date.now();
    const resp = await fetch(`${this.opts.proxyBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
        // Fail over to another OpenRouter provider instead of hard-failing
        // when the primary upstream has an outage.
        'X-Title': 'VS Code Copilot (or-cost-monitor)',
        'HTTP-Referer': 'https://github.com/microsoft/vscode',
        'X-OpenRouter-Categories': '',
      },
      body: bodyStr,
      signal: AbortSignal.timeout(300_000),
    });
    const elapsed = Date.now() - reqStart;
    log.info(`provideLanguageModelChatResponse upstream status=${resp.status} elapsed=${elapsed}ms`);

    if (token.isCancellationRequested) {
      log.info('provideLanguageModelChatResponse cancelled by caller');
      return;
    }

    if (!resp.ok || !resp.body) {
      // Capture the upstream error body so the root cause is visible.
      let detail = `OpenRouter ${resp.status}`;
      let raw = '';
      try {
        raw = await resp.text();
        detail = raw.trim().slice(0, 2000) || detail;
      } catch { /* ignore */ }
      const retriable = resp.status >= 500 || resp.status === 429 || !resp.status;
      if (retriable && retriesLeft > 0) {
        log.warn(`provideLanguageModelChatResponse FAILED status=${resp.status} — retrying (${retriesLeft} left). detail=${detail}`);
        await new Promise((r) => setTimeout(r, 1200 + (2 - retriesLeft) * 1800));
        return this.streamChatCompletion(body, progress, token, retriesLeft - 1);
      }
      log.error(`provideLanguageModelChatResponse FAILED status=${resp.status} elapsed=${elapsed}ms bodyLen=${bodyLen} detail=${detail}`);
      log.error(`FAILED request body: ${bodyStr.slice(0, 4000)}`);
      throw new Error(`OpenRouter request failed (${detail})`);
    }

    // --- SSE pump ---------------------------------------------------------
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Accumulate tool-call deltas across chunks (OpenRouter streams partial
    // arguments as separate deltas with the same index).
    const toolAcc: Array<{ index: number; id: string; name: string; args: string }> = [];

    try {
      for (;;) {
        if (token.isCancellationRequested) {
          log.info('provideLanguageModelChatResponse cancelled mid-stream');
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Extract complete lines: "data: {...}\n\n"
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk: {
            choices?: Array<{
              delta?: { content?: string | null; reasoning?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
              finish_reason?: string | null;
              message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
            }>;
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          // NOTE: we deliberately do NOT surface delta.reasoning as text —
          // that would leak chain-of-thought into the visible answer.
          if (delta?.content) {
            progress.report(new vscode.LanguageModelTextPart(delta.content));
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              const acc = (toolAcc[i] ??= { index: i, id: tc.id ?? '', name: '', args: '' });
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }
          // Non-streaming fallback shape (some providers send full message).
          if (!delta && choice?.message?.content) {
            progress.report(new vscode.LanguageModelTextPart(choice.message.content));
          }
          if (!delta && choice?.message?.tool_calls) {
            for (const tc of choice.message.tool_calls) {
              let input: object = {};
              try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
              progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, input));
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit final accumulated tool calls.
    for (const acc of toolAcc) {
      if (!acc.name) continue;
      let input: object = {};
      try { input = JSON.parse(acc.args || '{}'); } catch { /* keep {} */ }
      progress.report(new vscode.LanguageModelToolCallPart(acc.id, acc.name, input));
    }
    log.info('provideLanguageModelChatResponse completed successfully');
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Thenable<number> {
    // Rough heuristic; OpenRouter counts with the model's tokenizer but a
    // chars/4 approximation is fine for counting.
    const s = typeof text === 'string' ? text : text.content.map((p) => (typeof p === 'string' ? p : '')).join(' ');
    return Promise.resolve(Math.ceil(s.length / 4));
  }

  private buildRequestBody(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {
      model: model.id,
      messages: messages.map((m) => ({
        // VS Code's LanguageModelChatMessageRole is an enum (1=User, 2=Assistant,
        // 3=System). OpenRouter requires STRING roles — sending the raw number
        // ("role":3) makes OpenRouter return a 500 Internal Server Error.
        role: this.roleToString(m.role),
        content: this.serializeContent(m.content),
        ...(m.name ? { name: m.name } : {}),
      })),
    };
    if (options.tools?.length) {
      out.tools = options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema ?? {} } }));
      out.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
    }
    return out;
  }

  /** Map the numeric LanguageModelChatMessageRole enum to OpenRouter strings.
   *  Public type only declares User=1/Assistant=2, but the runtime (proposed
   *  API) also uses System=3. */
  private roleToString(role: vscode.LanguageModelChatMessageRole): string {
    switch (role as number) {
      case 2:
        return 'assistant';
      case 3:
        return 'system';
      case 1:
      default:
        return 'user';
    }
  }

  private serializeContent(content: ReadonlyArray<vscode.LanguageModelInputPart | unknown>): string {
    // OpenRouter (esp. DeepSeek) is strict: content must be a plain string or a
    // well-formed content-parts array. We collapse everything to a plain string
    // for maximum compatibility. Tool calls/results are inlined as text.
    const textParts: string[] = [];
    for (const p of content) {
      if (p instanceof vscode.LanguageModelTextPart) {
        textParts.push(p.value);
      } else if (p instanceof vscode.LanguageModelToolCallPart) {
        textParts.push(`[tool call: ${p.name}(${JSON.stringify(p.input)})]`);
      } else if (p instanceof vscode.LanguageModelToolResultPart) {
        textParts.push(
          p.content
            .map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : JSON.stringify(c)))
            .join('\n')
        );
      } else if (p && typeof p === 'object' && 'value' in (p as object)) {
        // LanguageModelDataPart (image) — skip; text-only for now
        const v = (p as { value?: unknown }).value;
        textParts.push(typeof v === 'string' ? v : '[image]');
      } else if (p != null) {
        textParts.push(String(p));
      }
    }
    // Never send empty content — some models reject it.
    return textParts.join('\n').trim() || '(empty message)';
  }
}

/** The concrete info type this provider exposes. */
export type ChatModelInfo = vscode.LanguageModelChatInformation;

// Re-export for convenience.
export { MODELS };