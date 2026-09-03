import {
  CreditsResponse,
  GenerationListResponse,
  GenerationData,
  KeyInfo,
  ModelPricing,
} from './types';

const OR_BASE = 'https://openrouter.ai/api/v1';

/** Minimal typed fetch wrapper with auth + error surfaced as a readable message. */
export class OpenRouterApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string
  ) {
    super(message);
  }
}

async function orFetch(path: string, apiKey: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${OR_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message;
    } catch {
      /* non-JSON error body */
    }
    const message = detail || `OpenRouter API ${res.status}: ${res.statusText}`;
    throw new OpenRouterApiError(res.status, message, detail);
  }
  return res;
}

/**
 * List generation history. Newest first.
 * `limit` max is 100, `cursor` paginates.
 */
export async function listGenerations(
  apiKey: string,
  opts: { limit?: number; cursor?: string } = {}
): Promise<GenerationListResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 50));
  if (opts.cursor) params.set('cursor', opts.cursor);
  const res = await orFetch(`/generation?${params.toString()}`, apiKey);
  return (await res.json()) as GenerationListResponse;
}

/** Paginate through the whole history, applying `page` to each batch, stopping early if it returns false. */
export async function forEachGeneration(
  apiKey: string,
  page: (gens: GenerationData[]) => boolean | void,
  opts: { limit?: number; maxBatches?: number } = {}
): Promise<{ pagesFetched: number; total: number }> {
  let cursor: string | undefined;
  let pagesFetched = 0;
  let total = 0;
  const limit = opts.limit ?? 100;
  const maxBatches = opts.maxBatches ?? 100;

  do {
    const res = await listGenerations(apiKey, { limit, cursor });
    pagesFetched++;
    total += res.data.length;
    if (res.data.length === 0 || page(res.data) === false || pagesFetched >= maxBatches) {
      break;
    }
    cursor = res.has_more ? res.data[res.data.length - 1]?.id : undefined;
  } while (cursor);

  return { pagesFetched, total };
}

/** Current key info: usage, limit, rate limits. */
export async function getKeyInfo(apiKey: string): Promise<KeyInfo> {
  const res = await orFetch('/key', apiKey);
  return (await res.json()) as KeyInfo;
}

/** Credit balance + total usage (POST required for this endpoint). */
export async function getCredits(apiKey: string): Promise<CreditsResponse> {
  const res = await orFetch('/credits', apiKey, { method: 'POST' });
  return (await res.json()) as CreditsResponse;
}

/** Model pricing for appending unknown models without burning history calls. */
export async function getModelPricing(
  apiKey: string,
  modelId: string
): Promise<ModelPricing | undefined> {
  try {
    const res = await orFetch(
      `/models/${encodeURIComponent(modelId)}`,
      apiKey
    );
    return (await res.json()) as ModelPricing;
  } catch {
    return undefined;
  }
}

/** https://openrouter.ai/docs/limits — free-tier models */
const FREE_MODEL_MARKERS = [':free', ':extended', '/free'];

export function isFreeModel(modelId: string): boolean {
  return FREE_MODEL_MARKERS.some((m) => modelId.includes(m));
}

export function toUsd(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '$0.0000';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(4)}`;
}

export function toTokens(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '0';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}