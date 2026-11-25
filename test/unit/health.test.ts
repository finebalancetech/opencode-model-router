import { describe, it, expect } from "vitest";
import { createHealthResolver, splitModelRef, type ProviderEndpoint } from "../../src/router/health";
import type { RouterConfig } from "../../src/router/config";

/** Minimal cfg with the healthCheck block under test. */
function cfgWith(healthCheck: RouterConfig["healthCheck"]): RouterConfig {
  return { healthCheck } as unknown as RouterConfig;
}

/** A fetch stub returning a JSON body with the given model ids, or throwing. */
function fetchWith(ids: string[] | "error"): typeof fetch {
  return (async () => {
    if (ids === "error") throw new Error("ECONNREFUSED");
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const endpoints: ProviderEndpoint[] = [
  { providerId: "pod", baseURL: "http://pod.local/v1", apiKey: "k" },
  { providerId: "remote" }, // no baseURL ⇒ unknown
];

function resolver(
  healthCheck: RouterConfig["healthCheck"],
  ids: string[] | "error",
  now?: () => number,
) {
  return createHealthResolver({
    cfg: cfgWith(healthCheck),
    listProviders: async () => endpoints,
    fetchImpl: fetchWith(ids),
    now,
  });
}

describe("splitModelRef", () => {
  it("splits provider/model", () => {
    expect(splitModelRef("pod/Groot-19B")).toEqual({ providerId: "pod", modelId: "Groot-19B" });
  });
  it("treats an unprefixed ref as a bare model", () => {
    expect(splitModelRef("Groot-19B")).toEqual({ providerId: "", modelId: "Groot-19B" });
  });
});

describe("createHealthResolver — tierHealth", () => {
  it("is up when the model id is present", async () => {
    const r = resolver({ enabled: true }, ["Groot-19B", "other"]);
    expect(await r.tierHealth("pod/Groot-19B")).toBe("up");
  });

  it("is down when the endpoint refuses the connection", async () => {
    const r = resolver({ enabled: true }, "error");
    expect(await r.tierHealth("pod/Groot-19B")).toBe("down");
  });

  it("is down when the model id is absent from the catalog", async () => {
    const r = resolver({ enabled: true }, ["other"]);
    expect(await r.tierHealth("pod/Groot-19B")).toBe("down");
  });

  it("is down on a non-2xx response (a stopped pod proxy answers 404 for every path)", async () => {
    const r = createHealthResolver({
      cfg: cfgWith({ enabled: true }),
      listProviders: async () => endpoints,
      fetchImpl: (async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch,
    });
    expect(await r.tierHealth("pod/Groot-19B")).toBe("down");
  });

  it("is unknown (treated up) when the provider has no baseURL", async () => {
    const r = resolver({ enabled: true }, ["Groot-19B"]);
    expect(await r.tierHealth("remote/anything")).toBe("unknown");
  });
});

describe("createHealthResolver — resolveTier escalation", () => {
  const ladder = ["fast", "medium", "heavy"];
  const candidates: Record<string, string[]> = {
    fast: ["pod/groot"],
    medium: ["pod/qwen"],
    heavy: ["remote/deepseek"],
  };
  const candidatesOf = (tier: string) => candidates[tier] ?? [];

  it("keeps the requested tier when it is up", async () => {
    const r = resolver({ enabled: true }, ["groot", "qwen", "deepseek"]);
    expect(await r.resolveTier("fast", ladder, candidatesOf)).toEqual({ tier: "fast", changed: false });
  });

  it("escalates fast→heavy when fast and medium are down and heavy is a probe:false floor", async () => {
    // pod endpoints down (model absent), remote has no baseURL ⇒ unknown/up.
    const r = resolver({ enabled: true, probe: { heavy: false } }, ["nope"]);
    expect(await r.resolveTier("fast", ladder, candidatesOf)).toEqual({ tier: "heavy", changed: true });
  });

  it("stops at a probe:false tier without probing it", async () => {
    const r = resolver({ enabled: true, probe: { medium: false } }, "error");
    // fast down (error), medium probe:false ⇒ treated up, stop there.
    expect(await r.resolveTier("fast", ladder, candidatesOf)).toEqual({ tier: "medium", changed: true });
  });

  it("keeps the requested tier when every probed tier is down", async () => {
    const r = resolver({ enabled: true }, "error");
    // all three on the pod ⇒ all down ⇒ keep fast, let it fail naturally.
    const allPod = (tier: string) => [tier === "heavy" ? "pod/deepseek" : candidates[tier][0]];
    expect(await r.resolveTier("fast", ladder, allPod)).toEqual({ tier: "fast", changed: false });
  });
});

describe("createHealthResolver — TTL cache", () => {
  it("re-probes only after the TTL elapses", async () => {
    let calls = 0;
    let t = 1_000;
    const r = createHealthResolver({
      cfg: cfgWith({ enabled: true, ttlMs: 10_000 }),
      listProviders: async () => endpoints,
      fetchImpl: (async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "groot" }] }) } as unknown as Response;
      }) as unknown as typeof fetch,
      now: () => t,
    });
    expect(await r.tierHealth("pod/groot")).toBe("up");
    expect(await r.tierHealth("pod/groot")).toBe("up");
    expect(calls).toBe(1); // cached within TTL
    t += 10_001;
    expect(await r.tierHealth("pod/groot")).toBe("up");
    expect(calls).toBe(2); // re-probed after TTL
  });
});