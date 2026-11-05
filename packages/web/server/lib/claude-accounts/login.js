import { createHash } from 'node:crypto';
import { z } from 'zod';

/** A plain JSON object: not an array, not null. */
export const objectSchema = z.record(z.string(), z.unknown());

/** The `claudeAiOauth` blob counts as a login only with a string access token. */
export const claudeAiOauthSchema = z.object({ accessToken: z.string().min(1) }).passthrough();

/**
 * What identifies one token pair without keeping it: a hash of the refresh
 * token (the access token when a login has none). Claude Code rotates a
 * refresh token when it refreshes, so a fingerprint names a token pair at one
 * moment, and every copy between live and the store records the new one.
 */
export const fingerprintOf = (claudeAiOauth) => {
  const secret = z.string().min(1).safeParse(claudeAiOauth?.refreshToken).data ?? claudeAiOauth?.accessToken ?? '';
  return createHash('sha256').update(String(secret)).digest('hex').slice(0, 32);
};
