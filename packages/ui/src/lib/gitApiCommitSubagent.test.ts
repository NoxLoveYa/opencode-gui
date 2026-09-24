import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const generatedPrompts: Array<{ sessionId: string; prompt: string }> = [];
const deletedSessions: string[] = [];
let smallModelCalls = 0;
let generateImpl: (sessionId: string, prompt: string) => Promise<string> = async () =>
  JSON.stringify({ subject: "feat: add silent commit path", highlights: ["subagent transport"] });

const opencodeModule = await import("@/lib/opencode/client");
// Derived from the real client rather than spread from it: the client is a
// class instance, so a spread drops every prototype method the other modules
// loaded in this process call at import time.
// SAFETY: `Object.create` returns `any`; the object delegates to the real
// client for everything the overrides below do not define.
const opencodeClientStub = Object.create(opencodeModule.opencodeClient) as typeof opencodeModule.opencodeClient;
opencodeClientStub.createSession = async (params, directory) => {
  createdSessions.push({ params, directory });
  return {
    id: "tmp-session-9",
    projectID: "project-1",
    directory: directory ?? "/repo",
    title: "",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  };
};
opencodeClientStub.generateSessionText = (sessionId: string, prompt: string) => {
  generatedPrompts.push({ sessionId, prompt });
  return generateImpl(sessionId, prompt);
};
opencodeClientStub.abortSession = async () => true;
opencodeClientStub.deleteSession = async (id: string) => {
  deletedSessions.push(id);
  return true;
};
mock.module("@/lib/opencode/client", () => ({ ...opencodeModule, opencodeClient: opencodeClientStub }));
type RealCreateParams = Parameters<typeof opencodeModule.opencodeClient.createSession>[0];
const createdSessions: Array<{
  params: RealCreateParams;
  directory: string | null | undefined;
}> = [];
const magicPromptsModule = await import("@/lib/magicPrompts");
mock.module("@/lib/magicPrompts", () => ({
  ...magicPromptsModule,
  renderMagicPrompt: async (id: string) => `PROMPT:${id}`,
}));
const gitApiHttpModule = await import("@/lib/gitApiHttp");
mock.module("@/lib/gitApiHttp", () => ({
  ...gitApiHttpModule,
  getGitDiff: async () => ({ diff: "DIFF-TEXT" }),
  getGitLog: async () => ({ all: [{ message: "old: thing" }] }),
}));
const smallModelRequestModule = await import("@/lib/smallModelRequest");
mock.module("@/lib/smallModelRequest", () => ({
  ...smallModelRequestModule,
  requestSmallModel: async () => {
    smallModelCalls += 1;
    return new Response(JSON.stringify({ text: JSON.stringify({ subject: "fix: small model path", highlights: [] }) }), {
      status: 200,
    });
  },
}));

const { generateCommitMessage } = await import("./gitApi");
const { useConfigStore } = await import("@/stores/useConfigStore");

const previousConfig = {
  currentProviderId: useConfigStore.getState().currentProviderId,
  currentModelId: useConfigStore.getState().currentModelId,
};

beforeEach(() => {
  createdSessions.length = 0;
  generatedPrompts.length = 0;
  deletedSessions.length = 0;
  smallModelCalls = 0;
  generateImpl = async () =>
    JSON.stringify({ subject: "feat: add silent commit path", highlights: ["subagent transport"] });
});

afterEach(() => {
  useConfigStore.setState({
    currentProviderId: previousConfig.currentProviderId,
    currentModelId: previousConfig.currentModelId,
  });
});

describe("generateCommitMessage transport selection", () => {
  test("opencode provider runs the silent subagent and never touches small-model", async () => {
    useConfigStore.setState({ currentProviderId: "opencode", currentModelId: "gpt-5-nano" });

    const result = await generateCommitMessage("/repo", ["a.ts"]);

    expect(result.message).toEqual({
      subject: "feat: add silent commit path",
      highlights: ["subagent transport"],
    });
    expect(smallModelCalls).toBe(0);
    expect(createdSessions).toEqual([
      { params: { model: { providerID: "opencode", id: "gpt-5-nano" } }, directory: "/repo" },
    ]);
    expect(generatedPrompts).toHaveLength(1);
    expect(String(generatedPrompts[0]?.prompt)).toContain("DIFF-TEXT");
    expect(deletedSessions).toEqual(["tmp-session-9"]);
  });

  test("opencode-go provider runs the silent subagent", async () => {
    useConfigStore.setState({ currentProviderId: "opencode-go", currentModelId: "zen-mini" });

    const result = await generateCommitMessage("/repo", ["a.ts"]);

    expect(result.message.subject).toBe("feat: add silent commit path");
    expect(smallModelCalls).toBe(0);
    expect(createdSessions[0]?.params).toEqual({ model: { providerID: "opencode-go", id: "zen-mini" } });
  });

  test("other providers keep the small-model transport and never spawn sessions", async () => {
    useConfigStore.setState({ currentProviderId: "anthropic", currentModelId: "claude-haiku-4-5" });

    const result = await generateCommitMessage("/repo", ["a.ts"]);

    expect(result.message.subject).toBe("fix: small model path");
    expect(smallModelCalls).toBe(1);
    expect(createdSessions).toEqual([]);
    expect(deletedSessions).toEqual([]);
  });

  test("an explicit opencode request model overrides the configured provider", async () => {
    useConfigStore.setState({ currentProviderId: "anthropic", currentModelId: "claude-haiku-4-5" });

    const result = await generateCommitMessage("/repo", ["a.ts"], {
      providerId: "opencode",
      modelId: "gpt-5-nano",
    });

    expect(result.message.subject).toBe("feat: add silent commit path");
    expect(smallModelCalls).toBe(0);
    expect(createdSessions[0]?.params).toEqual({ model: { providerID: "opencode", id: "gpt-5-nano" } });
  });

  test("a subagent failure surfaces without falling back, and the session is cleaned up", async () => {
    useConfigStore.setState({ currentProviderId: "opencode", currentModelId: "gpt-5-nano" });
    const failure = new Error("zen refused");
    generateImpl = async () => {
      throw failure;
    };

    let caught: unknown;
    try {
      await generateCommitMessage("/repo", ["a.ts"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(smallModelCalls).toBe(0);
    expect(deletedSessions).toEqual(["tmp-session-9"]);
  });
});
