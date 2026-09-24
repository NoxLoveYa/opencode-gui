import { describe, expect, test } from "bun:test"
import {
  generateTextViaSilentSubagent,
  isOpencodeManagedProvider,
  type SilentSubagentClient,
} from "./subagentGeneration"

type CreateCall = {
  params: { model: { providerID: string; id: string } };
  directory: string | null | undefined;
};
type GenerateCall = {
  sessionId: string;
  prompt: string;
  directory: string | null | undefined;
};
type IdCall = { id: string; directory: string | null | undefined };
type RecordedCalls = { create: CreateCall[]; generate: GenerateCall[]; abort: IdCall[]; deleted: IdCall[] };

const stubClient = (overrides?: Partial<SilentSubagentClient>): SilentSubagentClient & {
  calls: RecordedCalls;
} => {
  const calls: RecordedCalls = {
    create: [],
    generate: [],
    abort: [],
    deleted: [],
  };
  return {
    calls,
    createSession: async (params, directory) => {
      calls.create.push({ params, directory });
      return { id: "tmp-session-1" };
    },
    generateSessionText: async (sessionId, prompt, directory) => {
      calls.generate.push({ sessionId, prompt, directory });
      return "  generated text  ";
    },
    abortSession: async (id, directory) => {
      calls.abort.push({ id, directory });
      return true;
    },
    deleteSession: async (id, directory) => {
      calls.deleted.push({ id, directory });
      return true;
    },
    ...overrides,
  };
};

const base = { directory: "/repo", prompt: "write a commit message", providerID: "opencode", modelID: "gpt-5-nano" };

describe("isOpencodeManagedProvider", () => {
  test("matches the OpenCode-served providers only", () => {
    expect(isOpencodeManagedProvider("opencode")).toBe(true);
    expect(isOpencodeManagedProvider("opencode-go")).toBe(true);
    expect(isOpencodeManagedProvider("anthropic")).toBe(false);
    expect(isOpencodeManagedProvider("openai")).toBe(false);
    expect(isOpencodeManagedProvider(null)).toBe(false);
    expect(isOpencodeManagedProvider(undefined)).toBe(false);
    expect(isOpencodeManagedProvider("")).toBe(false);
  });
});

describe("generateTextViaSilentSubagent", () => {
  test("creates a session on the pinned model, generates, deletes, and trims", async () => {
    const client = stubClient();
    const result = await generateTextViaSilentSubagent({ ...base, client });

    expect(result).toEqual({ text: "generated text", providerID: "opencode", modelID: "gpt-5-nano" });
    expect(client.calls.create).toEqual([
      { params: { model: { providerID: "opencode", id: "gpt-5-nano" } }, directory: "/repo" },
    ]);
    expect(client.calls.generate).toEqual([
      { sessionId: "tmp-session-1", prompt: "write a commit message", directory: "/repo" },
    ]);
    expect(client.calls.deleted).toEqual([{ id: "tmp-session-1", directory: "/repo" }]);
    expect(client.calls.abort).toEqual([]);
  });

  test("a generation failure surfaces and the session is still deleted", async () => {
    const failure = new Error("model exploded");
    const client = stubClient({
      generateSessionText: async () => {
        throw failure;
      },
    });

    let caught: unknown;
    try {
      await generateTextViaSilentSubagent({ ...base, client });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(client.calls.deleted).toEqual([{ id: "tmp-session-1", directory: "/repo" }]);
    expect(client.calls.abort).toEqual([]);
  });

  test("a creation failure performs no cleanup calls", async () => {
    const failure = new Error("cannot create");
    const client = stubClient({
      createSession: async () => {
        throw failure;
      },
    });

    let caught: unknown;
    try {
      await generateTextViaSilentSubagent({ ...base, client });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(client.calls.generate).toEqual([]);
    expect(client.calls.abort).toEqual([]);
    expect(client.calls.deleted).toEqual([]);
  });

  test("a timeout aborts the runaway session, deletes it, and throws", async () => {
    const client = stubClient({
      generateSessionText: () => new Promise<string>(() => {}),
    });

    await expect(generateTextViaSilentSubagent({ ...base, client, timeoutMs: 20 })).rejects.toThrow(
      /timed out after 20ms/,
    );
    expect(client.calls.abort).toEqual([{ id: "tmp-session-1", directory: "/repo" }]);
    expect(client.calls.deleted).toEqual([{ id: "tmp-session-1", directory: "/repo" }]);
  });

  test("a delete failure does not mask the generated text", async () => {
    const client = stubClient({
      deleteSession: async () => {
        throw new Error("delete failed");
      },
    });

    const result = await generateTextViaSilentSubagent({ ...base, client });
    expect(result.text).toBe("generated text");
  });
});
