/** Shared types for the OpenRouter cost monitor. */

export interface GenerationUsage {
  /** Total tokens billed for this request. */
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens?: number;
  /** Cost in USD (already reflects provider pricing, caching discounts, etc.). */
  cost?: number;
}

export interface GenerationData {
  id: string;
  model: string;
  created_at?: string;
  /** ISO timestamp when the request finished. */
  ended_at?: string;
  usage?: GenerationUsage;
  /** Whether the request was streamed. */
  is_streamed?: boolean;
  /** Optional request body metadata when moderation allows. */
  request?: {
    model?: string;
    prompt?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  /** Provider that actually served the request. */
  provider?: string | null;
}

export interface GenerationListResponse {
  data: GenerationData[];
  has_more: boolean;
  total_cost?: number | null;
  limit: number;
}

export interface KeyInfo {
  label?: string;
  usage: number;
  limit: number;
  is_free_tier?: boolean;
  rate_limit?: {
    requests: number;
    interval: string;
  };
}

export interface CreditsResponse {
  total_credits: number;
  total_usage: number;
  has_payment_method?: boolean;
}

export interface ModelPricing {
  id: string;
  name?: string;
  context_length?: number | null;
  pricing?: {
    prompt: string;
    completion: string;
    image?: string;
    request?: string;
  };
}

/** Rolled-up stats for a time window. */
export interface UsageSummary {
  totalCost: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  requestCount: number;
  byModel: Map<string, { cost: number; tokens: number; requests: number }>;
  /** ISO date keys -> model -> stats, for the dashboard chart. */
  daily: Map<string, Map<string, { cost: number; tokens: number; requests: number }>>;
}

/** A single row shown in the Recent Requests tree view. */
export interface RequestRow {
  id: string;
  model: string;
  cost: number;
  tokens: number;
  timestamp: number;
  provider?: string | null;
}