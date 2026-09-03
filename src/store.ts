import * as vscode from 'vscode';
import { UsageSummary, RequestRow, GenerationData } from './types';
import { toTokens } from './api';

const SUMMARY_KEY = 'orCost.summary';
const RECENT_KEY = 'orCost.recent';

/** Renders the UsageSummary into a stable plain-JSON shape for persistence. */
export function serializeSummary(s: UsageSummary) {
  return {
    totalCost: s.totalCost,
    totalTokens: s.totalTokens,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    reasoningTokens: s.reasoningTokens,
    requestCount: s.requestCount,
    byModel: Array.from(s.byModel.entries()).map(([k, v]) => [k, v]),
    daily: Array.from(s.daily.entries()).map(([date, m]) => [
      date,
      Array.from(m.entries()).map(([k, v]) => [k, v]),
    ]),
  };
}

export function deserializeSummary(raw: unknown): UsageSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as {
    totalCost?: number;
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    requestCount?: number;
    byModel?: [string, { cost: number; tokens: number; requests: number }][];
    daily?: [string, [string, { cost: number; tokens: number; requests: number }][]][];
  };
  return {
    totalCost: r.totalCost ?? 0,
    totalTokens: r.totalTokens ?? 0,
    promptTokens: r.promptTokens ?? 0,
    completionTokens: r.completionTokens ?? 0,
    reasoningTokens: r.reasoningTokens ?? 0,
    requestCount: r.requestCount ?? 0,
    byModel: new Map(r.byModel ?? []),
    daily: new Map((r.daily ?? []).map(([d, entries]) => [d, new Map(entries)])),
  };
}

export function emptySummary(): UsageSummary {
  return {
    totalCost: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    requestCount: 0,
    byModel: new Map(),
    daily: new Map(),
  };
}

/** Merge a batch of generations into an existing summary (rolling forward). */
export function mergeGenerations(summary: UsageSummary, gens: GenerationData[]): UsageSummary {
  for (const g of gens) {
    const u = g.usage;
    if (!u) continue;
    const model = g.model || g.request?.model || '(unknown)';
    const date = (g.ended_at || g.created_at || new Date().toISOString()).slice(0, 10);
    const cost = u.cost ?? 0;
    const tokens = (u.total_tokens ?? (u.prompt_tokens + u.completion_tokens)) || 0;
    const prompt = u.prompt_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    const reasoning = u.reasoning_tokens ?? 0;

    summary.totalCost += cost;
    summary.totalTokens += tokens;
    summary.promptTokens += prompt;
    summary.completionTokens += completion;
    summary.reasoningTokens += reasoning;
    summary.requestCount += 1;

    const byModel = summary.byModel.get(model) ?? { cost: 0, tokens: 0, requests: 0 };
    byModel.cost += cost;
    byModel.tokens += tokens;
    byModel.requests += 1;
    summary.byModel.set(model, byModel);

    const day = summary.daily.get(date) ?? new Map();
    const dm = day.get(model) ?? { cost: 0, tokens: 0, requests: 0 };
    dm.cost += cost;
    dm.tokens += tokens;
    dm.requests += 1;
    day.set(model, dm);
    summary.daily.set(date, day);
  }
  return summary;
}

export function recomputeSummary(gens: GenerationData[]): UsageSummary {
  return mergeGenerations(emptySummary(), gens);
}

export function toRequestRows(gens: GenerationData[], limit = 100): RequestRow[] {
  return gens
    .slice(0, limit)
    .map((g) => {
      const u = g.usage;
      return {
        id: g.id,
        model: g.model || g.request?.model || '(unknown)',
        cost: u?.cost ?? 0,
        tokens: u?.total_tokens ?? (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0),
        timestamp: Date.parse(g.ended_at || g.created_at || new Date().toISOString()),
        provider: g.provider,
      } as RequestRow;
    });
}

export class UsageStore {
  private summary: UsageSummary = emptySummary();
  private recent: RequestRow[] = [];
  private lastFetchAt: number = 0;
  private lastError: string | undefined;

  constructor(private readonly memento: vscode.Memento) {
    this.summary = deserializeSummary(memento.get(SUMMARY_KEY)) ?? emptySummary();
    this.recent = (memento.get<RequestRow[]>(RECENT_KEY) ?? []).slice(0, 200);
  }

  get current(): UsageSummary {
    return this.summary;
  }

  get recentRows(): RequestRow[] {
    return this.recent;
  }

  get lastFetched(): number {
    return this.lastFetchAt;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  /** Persist the fast-immutable parts. Called after every merge. */
  persist(): void {
    void this.memento.update(SUMMARY_KEY, serializeSummary(this.summary));
    void this.memento.update(RECENT_KEY, this.recent.slice(0, 200));
  }

  setError(err: string): void {
    this.lastError = err;
  }

  clearError(): void {
    this.lastError = undefined;
  }

  resetSession(): void {
    this.summary = emptySummary();
    this.recent = [];
    this.persist();
  }

  merge(gens: GenerationData[]): void {
    mergeGenerations(this.summary, gens);
    this.recent = [...toRequestRows(gens), ...this.recent]
      .filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i)
      .slice(0, 200);
    this.lastFetchAt = Date.now();
    this.persist();
  }

  setRowsFromHistory(gens: GenerationData[]): void {
    this.summary = recomputeSummary(gens);
    this.recent = toRequestRows(gens, 200);
    this.lastFetchAt = Date.now();
    this.persist();
  }

  /** Current-session spend since last reset (or since extension started). */
  sessionCost(): number {
    return this.summary.totalCost;
  }
}

export function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function formatTokens(n: number): string {
  return toTokens(n);
}