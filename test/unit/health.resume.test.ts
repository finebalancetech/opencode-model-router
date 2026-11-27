/**
 * Endpoint health preflight on a RESUME (the case that used to abort): a tier subagent created
 * while its GPU box was up keeps that model pinned, so when the box goes away every resume of it
 * failed at the provider with `no route for model '<id>'`. The preflight now covers a resume too:
 * the child keeps its agent, and the turn carries the escalated tier's model instead.
 *
 * A fresh dispatch still escalates the tier itself (routing fills that tier's model).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerV2Hooks } from "../../src/compat/v2-hooks";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, overridePath } from "../../src/router/config";
import type { RouterPluginInput } from "../../src/compat/child-session";

const GROOT = "custom-gpu/groot-19b";
const DEEPSEEK = "opencode-go/deepseek-v4.1-flash";

const cleanups: Array<() => Promise<void> | void> = [];
let home: string;
let id = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omr-health-resume-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  invalidateConfigCache();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  invalidateConfigCache();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** fast/medium on the gateway box, heavy on the always-up remote; health preflight on. */
const OVERRIDE = {
  activePreset: "local",
  presets: {
    local: {
      fast: { model: GROOT, costRatio: 1, steps: 30, readOnly: true },
      medium: { model: GROOT, costRatio: 1, steps: 50 },
      heavy: { model: DEEPSEEK, costRatio: 3, steps: 120 },
    },
  },
  healthCheck: { enabled: true, ttlMs: 45_000, timeoutMs: 1_500, probe: { heavy: false } },
};

/** The gateway answers /models without the box: the tier's model is gone, the endpoint is up. */
function gatewayWithoutGroot() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "some-other-model" }] }),
  } as unknown as Response)) as unknown as typeof fetch;
}

async function host(directory: string, fetchImpl: typeof fetch) {
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify(OVERRIDE));
  invalidateConfigCache();
  vi.stubGlobal("fetch", fetchImpl);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = (sessionID: string) => (sessionID === "root"
    ? { id: sessionID, agent: "build", location: { directory } }
    : { id: sessionID, parentID: "root", agent: "medium", location: { directory } });
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const none = () => ({ dispose: vi.fn(async () => {}) });
  const agents: Record<string, any> = { build: { id: "build", mode: "primary", permissions: [], request: { settings: {}, headers: {}, body: {} } } };
  const ctx = {
    location: { directory, project: { directory } },
    agent: {
      reload: vi.fn(async () => {}),
      list: vi.fn(async () => ({ data: Object.values(agents) })),
      transform: vi.fn(async (cb: any) => {
        cb({ update: (name: string, apply: (agent: any) => void) => { agents[name] ??= { id: name, mode: "primary", permissions: [], request: {} }; apply(agents[name]); } });
        return none();
      }),
    },
    command: { reload: vi.fn(async () => {}), transform: vi.fn(async () => none()) },
    tool: { transform: vi.fn(async () => none()), hook: vi.fn(async (name: string, cb: any) => { toolHooks[name] = cb; return none(); }) },
    provider: {
      list: vi.fn(async () => ({
        data: [
          { id: "custom-gpu", settings: { baseURL: "https://gw.example/v1", apiKey: "k" } },
          { id: "opencode-go", settings: {} }, // no baseURL ⇒ never probed
        ],
      })),
    },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => info(sessionID)),
      update: vi.fn(async () => {}),
      context: vi.fn(async () => [] as unknown[]),
      prompt: vi.fn(async () => {}), synthetic: vi.fn(async () => {}),
      hook: vi.fn(async () => none()),
    },
    permission: { hook: vi.fn(async () => none()) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      yield* [] as never[];
    } },
  };
  const client = { session: { get: async ({ path }: { path: { id: string } }) => ({ data: info(path.id) }) } };
  const hooks = await ModelRouterPlugin({ directory, worktree: directory, client, routerHost: "v2" } as unknown as RouterPluginInput);
  cleanups.push(await registerV2Hooks(ctx as unknown as Context, hooks as Hooks));
  // `event.input` is reassigned by the adapter (nativeArgs), so the call's outcome is read from the event.
  return async (input: Record<string, unknown>) => {
    const event: Record<string, unknown> = { sessionID: "root", agent: "build", messageID: "m", id: `t${++id}`, tool: "subagent", input };
    await toolHooks["execute.before"](event);
    return event.input as Record<string, unknown>;
  };
}

describe("health preflight — a resume runs on the escalated tier's model", () => {
  it("pinned tier model gone: the resumed turn carries the heavy model, the child keeps its agent", async () => {
    const call = await host(home, gatewayWithoutGroot());
    const input = await call({ agent: "medium", prompt: "continue and finish", sessionID: "child-1" });
    expect(input.model).toBe(DEEPSEEK);
    expect(input.agent).toBe("medium");
    expect(input.sessionID).toBe("child-1");
  });

  it("a fresh dispatch still escalates its tier instead of pinning a model", async () => {
    const call = await host(home, gatewayWithoutGroot());
    const input = await call({ agent: "fast", prompt: "do the thing", description: "task" });
    expect(input.agent).toBe("heavy");
  });

  it("a healthy endpoint leaves the resume alone", async () => {
    const healthy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "groot-19b" }] }),
    } as unknown as Response)) as unknown as typeof fetch;
    const call = await host(home, healthy);
    const input = await call({ agent: "medium", prompt: "continue", sessionID: "child-2" });
    expect(input.model).toBeUndefined();
    expect(input.agent).toBe("medium");
  });
});
