const TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

/** Replaces anything shaped like an Anthropic token, so no message can carry one. */
export const redactSecrets = (text) => String(text ?? '').replace(TOKEN_PATTERN, '[redacted]');

/**
 * An error a route can answer with: a stable `code` the UI maps to its own
 * wording, and a message that already went through the redactor.
 */
export class ClaudeAccountError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, credentialId?: string }} [details]
   */
  constructor(code, message, { status = 500, credentialId } = {}) {
    super(redactSecrets(message));
    this.name = 'ClaudeAccountError';
    this.code = code;
    this.status = status;
    if (credentialId) this.credentialId = credentialId;
  }
}

/** Any thrown value as a `ClaudeAccountError`, redacted. */
export const toClaudeAccountError = (error) => {
  if (error instanceof ClaudeAccountError) return error;
  return new ClaudeAccountError('internal', error instanceof Error ? error.message : String(error));
};
