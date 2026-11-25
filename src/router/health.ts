/**
 * src/router/health.ts — opt-in endpoint health preflight (v2 only).
 *
 * Before a tier subagent is dispatched, the router may probe the tier model's
 * provider `/models` endpoint (OpenAI-compatible). If the endpoint is
 * unreachable or the model id is absent, the caller escalates the dispatch to
 * the next tier up (fast→medium→heavy). Results are TTL-cached so the probe
 * adds no perceptible latency and a pod that flaps is re-checked within one
 * TTL window. No network/SDK beyond a single `fetch`; the live provider list
 * and clock are injected so the resolver is unit-testable.
 */
import type { RouterConfig } from "./config";

export type TierHealth = "up" | "down" | "unknown";

/** One provider's endpoint as the host reports it (`Provider.options`). */
export interface ProviderEndpoint {
  providerId: string;
  baseURL?: string;
  apiKey?: string;
}

export interface HealthResolverDeps {
  cfg: RouterConfig;
  /** The host's provider list, mapped to endpoints. A throw is treated as "none". */
  listProviders: () => Promise<ProviderEndpoint[]>;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Receives one line per escalation/decision, secret-free. */
  log?: (message: string) => void;
}

interface ProbeResult {
  reachable: boolean;
  /** Set when a response was received (any status). */
  httpStatus?: number;
  /** Model ids from an OpenAI-compatible `{ data: [{ id }] }` body. */
  modelIds?: Set<string>;
}

/** Split a `provider/model` ref. Returns the bare string as the model when unprefixed. */
export function splitModelRef(model: string): { providerId: string; modelId: string } {
  const i = model.indexOf("/");
  return i < 0 ? { providerId: "", modelId: model } : { providerId: model.slice(0, i), modelId: model.slice(i + 1) };
}

export interface HealthResolver {
  /** Health of a tier's primary model: "down" only on a refused/timeout probe or an absent model id. */
  tierHealth(model: string): Promise<TierHealth>;
  /**
   * The tier to dispatch on, starting at `requested` and escalating up `ladder`
   * while a tier's primary candidate is down. A tier with `probe: false` is
   * treated as always-up and stops the walk. Returns the requested tier when
   * every probed tier is down (the dispatch is left to fail naturally).
   */
  resolveTier(requested: string, ladder: readonly string[], candidatesOf: (tier: string) => readonly string[]): Promise<{ tier: string; changed: boolean }>;
}

export function createHealthResolver(deps: HealthResolverDeps): HealthResolver {
  const ttlMs = deps.cfg.healthCheck?.ttlMs ?? 45_000;
  const timeoutMs = deps.cfg.healthCheck?.timeoutMs ?? 1_500;
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  // Provider list is cached alongside health so a dispatch does at most one
  // host call + one probe per TTL window.
  let providerCache: { at: number; endpoints: ProviderEndpoint[] } | undefined;
  const healthCache = new Map<string, { at: number; status: TierHealth }>();

  async function endpoints(): Promise<ProviderEndpoint[]> {
    if (providerCache && now() - providerCache.at < ttlMs) return providerCache.endpoints;
    let eps: ProviderEndpoint[] = [];
    try {
      eps = await deps.listProviders();
    } catch (error) {
      log(`[router] health: provider list failed (${String(error)}); treating endpoints as unknown`);
    }
    providerCache = { at: now(), endpoints: eps };
    return eps;
  }

  async function probe(baseURL: string, apiKey: string | undefined): Promise<ProbeResult> {
    const url = `${baseURL.replace(/\/+$/, "")}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await doFetch(url, { method: "GET", headers, signal: controller.signal });
      if (!res.ok) return { reachable: true, httpStatus: res.status };
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { reachable: true, httpStatus: res.status };
      }
      const ids = new Set<string>();
      const data = (body as { data?: unknown } | null)?.data;
      if (Array.isArray(data)) {
        for (const m of data) {
          const id = (m as { id?: unknown } | null)?.id;
          if (typeof id === "string") ids.add(id);
        }
      }
      return { reachable: true, httpStatus: res.status, modelIds: ids };
    } catch (error) {
      return { reachable: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async function tierHealth(model: string): Promise<TierHealth> {
    const { providerId, modelId } = splitModelRef(model);
    const cached = healthCache.get(model);
    if (cached && now() - cached.at < ttlMs) return cached.status;
    const ep = (await endpoints()).find((p) => p.providerId === providerId);
    // No baseURL (e.g. a host-managed remote provider) ⇒ unknown, treated as up.
    if (!ep || !ep.baseURL) return "unknown";
    const result = await probe(ep.baseURL, ep.apiKey);
    let status: TierHealth;
    if (!result.reachable) status = "down";
    else if (result.httpStatus !== undefined && (result.httpStatus < 200 || result.httpStatus >= 300)) status = "unknown";
    else if (result.modelIds && !result.modelIds.has(modelId)) status = "down";
    else status = "up";
    healthCache.set(model, { at: now(), status });
    return status;
  }

  async function resolveTier(
    requested: string,
    ladder: readonly string[],
    candidatesOf: (tier: string) => readonly string[],
  ): Promise<{ tier: string; changed: boolean }> {
    const start = ladder.indexOf(requested);
    const order = start < 0 ? [requested, ...ladder] : [...ladder.slice(start)];
    for (const tier of order) {
      if (deps.cfg.healthCheck?.probe?.[tier] === false) {
        return { tier, changed: tier !== requested }; // never probed ⇒ always-up floor
      }
      const primary = candidatesOf(tier)[0];
      if (!primary) return { tier, changed: tier !== requested };
      const health = await tierHealth(primary);
      if (health !== "down") {
        if (tier !== requested) log(`[router] health: @${requested} endpoint down; escalating to @${tier}`);
        return { tier, changed: tier !== requested };
      }
    }
    return { tier: requested, changed: false }; // everything probed is down; let it fail naturally
  }

  return { tierHealth, resolveTier };
}