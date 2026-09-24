import { opencodeClient } from './opencode/client';

/**
 * Providers served by OpenCode itself (Zen gateway and friends). The
 * stateless `/api/experimental/generate` endpoint does not serve them, so
 * background generations on these providers run as a silent throwaway
 * session instead.
 */
export function isOpencodeManagedProvider(providerID: string | null | undefined): boolean {
  return providerID === 'opencode' || providerID === 'opencode-go';
}

const SILENT_SUBAGENT_TIMEOUT_MS = 60_000;

export type SilentSubagentClient = {
  createSession: (
    params: { model: { providerID: string; id: string } },
    directory?: string | null,
  ) => Promise<{ id: string }>;
  generateSessionText: (sessionId: string, prompt: string, directory?: string | null) => Promise<string>;
  abortSession: (id: string, directory?: string | null) => Promise<boolean>;
  deleteSession: (id: string, directory?: string | null) => Promise<boolean>;
};

const timeoutError = (providerID: string, modelID: string, timeoutMs: number) =>
  Object.assign(
    new Error(`Silent generation on ${providerID}/${modelID} timed out after ${timeoutMs}ms`),
    { code: 'subagent-timeout', providerID, modelID },
  );

/**
 * Runs one prompt on the given model in a throwaway session and returns its
 * text. `session.generate` never enters history, and the session is deleted
 * afterwards, so nothing lands in the transcript, the session list, or the
 * chat scroll position. Errors — including the timeout — propagate to the
 * caller; cleanup failures are logged and never mask them.
 */
export async function generateTextViaSilentSubagent({
  directory,
  prompt,
  providerID,
  modelID,
  timeoutMs = SILENT_SUBAGENT_TIMEOUT_MS,
  client = opencodeClient,
}: {
  directory: string;
  prompt: string;
  providerID: string;
  modelID: string;
  timeoutMs?: number;
  client?: SilentSubagentClient;
}): Promise<{ text: string; providerID: string; modelID: string }> {
  const session = await client.createSession({ model: { providerID, id: modelID } }, directory);
  const sessionId = session.id;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const text = await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(timeoutError(providerID, modelID, timeoutMs));
        }, timeoutMs);
        client.generateSessionText(sessionId, prompt, directory).then(
          (value) => {
            if (timer) clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            if (timer) clearTimeout(timer);
            reject(error);
          },
        );
      });
      return { text: text.trim(), providerID, modelID };
    } catch (error) {
      // A timed-out generation keeps running server-side; abort it before
      // deleting so it cannot keep spending the user's quota unnoticed.
      if (timedOut) {
        await client.abortSession(sessionId, directory).catch(() => undefined);
      }
      throw error;
    }
  } finally {
    await client.deleteSession(sessionId, directory).catch((error) => {
      console.error('[subagent-generation] failed to delete throwaway session', {
        sessionId,
        providerID,
        modelID,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
