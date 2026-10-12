/**
 * Pure context-cost comparison: carry the current history (all cache reads) versus
 * a fresh window loading a fixed background. Standard API-equivalent USD only.
 * Rates come from Pi's model.cost (USD per 1,000,000 tokens) for OpenAI providers.
 */

export type StartupMode = "cache-write" | "uncached-input";
export interface Rates { input: number; cacheRead: number; cacheWrite: number }
interface Tier extends Rates { inputTokensAbove: number }
export interface PriceModel { id: string; provider: string; cost?: unknown }

export const DEFAULT_STARTUP_TOKENS = 50_000;
/** Other providers' cost data often leaves cache prices unset; do not guess for them. */
export const PRICED_PROVIDERS: readonly string[] = ["openai", "openai-codex"];
/**
 * Quota billing that waives the long-context tiers, by provider then exact model ID.
 * Codex subscription quota for gpt-6.1-sol has no long-context surcharge (user notice, 2026-10-11);
 * Pi's model data still lists the tier.
 */
export const UNTIERED: Readonly<Record<string, readonly string[]>> = { "openai-codex": ["gpt-6.1-sol"] };

export interface EstimateInput {
  model: PriceModel;
  /** H: tokens charged as cached history. */
  historyTokens: unknown;
  /** T: total input of the next request; selects the tier. */
  nextTotalInputTokens: unknown;
  startupTokens?: number;
  startupMode?: StartupMode;
}
export interface Estimate {
  /** null when H or T is unknown; never coerced to 0. */
  historyUsd: number | null;
  startupUsd: number;
  /** false when the provider waives the long-context tier for this model. */
  tiered: boolean;
}

const rate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const knownCount = rate;

/**
 * Validate one rate set. A cache read price of 0 means no cache discount (or missing data): unpriced.
 * A cache write price of 0 means no write surcharge on OpenAI models: first-time input bills as input.
 */
function rates(value: unknown): Rates | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { input, cacheRead, cacheWrite } = value as Record<string, unknown>;
  if (!rate(input) || !rate(cacheRead) || !rate(cacheWrite) || input <= 0 || cacheRead <= 0) return undefined;
  return { input, cacheRead, cacheWrite: cacheWrite > 0 ? cacheWrite : input };
}

/** Base rates plus request-wide tiers; any malformed tier makes the whole model unpriced. */
interface Price { base: Rates; tiers: Tier[]; tiered: boolean }

export function priceTiers(model: PriceModel): Price | undefined {
  if (!PRICED_PROVIDERS.includes(model.provider)) return undefined;
  const base = rates(model.cost);
  if (!base) return undefined;
  const raw = (model.cost as Record<string, unknown>).tiers ?? [];
  if (!Array.isArray(raw)) return undefined;
  const tiers: Tier[] = [];
  for (const entry of raw) {
    const tierRates = rates(entry);
    const above = (entry as Record<string, unknown> | null)?.inputTokensAbove;
    if (!tierRates || !rate(above)) return undefined;
    tiers.push({ ...tierRates, inputTokensAbove: above });
  }
  const tiered = !(Object.hasOwn(UNTIERED, model.provider) && UNTIERED[model.provider].includes(model.id));
  return { base, tiers: tiered ? tiers : [], tiered };
}

/** Same rule as Pi's calculateCost: the highest threshold below total input applies to the whole request. */
function tierFor(price: Price, totalInput: number): Rates {
  let selected: Rates = price.base;
  let threshold = -1;
  for (const tier of price.tiers) {
    if (totalInput > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      selected = tier;
      threshold = tier.inputTokensAbove;
    }
  }
  return selected;
}

/** Returns undefined for a model without usable OpenAI pricing. */
export function estimate(input: EstimateInput): Estimate | undefined {
  const price = priceTiers(input.model);
  if (!price) return undefined;

  const { historyTokens: h, nextTotalInputTokens: t } = input;
  const historyUsd = knownCount(h) && knownCount(t) ? h / 1_000_000 * tierFor(price, t).cacheRead : null;

  const startupTokens = input.startupTokens ?? DEFAULT_STARTUP_TOKENS;
  const startupTier = tierFor(price, startupTokens);
  const startupRate = (input.startupMode ?? "cache-write") === "cache-write" ? startupTier.cacheWrite : startupTier.input;
  return { historyUsd, startupUsd: startupTokens / 1_000_000 * startupRate, tiered: price.tiered };
}

const usd = (value: number) => `$${value.toFixed(4)}`;

/** Labels stay short; pricing basis, startup size and mode are documented in README/config. */
export function formatStatus(result: Estimate | undefined): string {
  if (!result) return "API price not configured";
  const history = result.historyUsd === null ? "—" : usd(result.historyUsd);
  return `Cache read ${history} | Cold start ${usd(result.startupUsd)}`;
}
