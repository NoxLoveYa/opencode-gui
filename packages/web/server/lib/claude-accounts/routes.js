import { z } from 'zod';

import { ClaudeAccountError, redactSecrets, toClaudeAccountError } from './errors.js';

const ROUTE = '/api/openchamber/claude-accounts';

const startLoginSchema = z.object({
  credentialId: z.string().min(1).max(200).optional(),
  label: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
});
const codeSchema = z.object({ code: z.string().min(1).max(4096) });
const credentialSchema = z.object({ credentialId: z.string().min(1).max(200) });
const saveLiveSchema = z.object({ label: z.string().max(200).optional() });

/**
 * HTTP surface of the Claude accounts feature: the page's routes, and the
 * interception of OpenCode's own credential routes that makes the existing
 * "Use" and remove buttons move the Claude login. Register before the generic
 * OpenCode proxy.
 *
 * Responses never carry a token: the runtime only hands out metadata, and
 * every error passes the redactor. Every request that changes something has to
 * say it comes from a script of this app, with a JSON body or an
 * `X-Requested-With` header, which a page on another origin cannot send
 * without OpenChamber's consent.
 *
 * @param {import('express').Express} app
 * @param {{ express: typeof import('express'), runtime: ReturnType<import('./runtime.js').createClaudeAccountsRuntime>, logger?: Pick<Console, 'warn'> }} options
 */
export const registerClaudeAccountRoutes = (app, { express, runtime, logger = console }) => {
  const sendError = (res, error) => {
    const failure = toClaudeAccountError(error);
    if (failure.status >= 500) logger.warn(`[claude-accounts] ${failure.code}: ${failure.message}`);
    const body = { error: redactSecrets(failure.message), code: failure.code };
    if (failure.credentialId) body.credentialId = failure.credentialId;
    return res.status(failure.status).json(body);
  };

  const requireIntent = (req) => {
    if (req.is('application/json') || req.get('x-requested-with')) return;
    throw new ClaudeAccountError('intent-required', 'This request has to come from OpenChamber.', { status: 415 });
  };

  /** A handler for a request that changes something. */
  const handler = (work, { mutates = false } = {}) => async (req, res) => {
    try {
      if (mutates) requireIntent(req);
      return await work(req, res);
    } catch (error) {
      return sendError(res, error);
    }
  };

  const parseBody = (schema, req) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ClaudeAccountError('invalid-request', 'Invalid request.', { status: 400 });
    return parsed.data;
  };

  const json = express.json({ limit: '16kb' });

  app.get(ROUTE, handler(async (_req, res) => res.json(await runtime.getState())));

  app.post(`${ROUTE}/logins`, json, handler(async (req, res) => (
    res.json(await runtime.startLogin(parseBody(startLoginSchema, req)))
  ), { mutates: true }));

  app.get(`${ROUTE}/logins/:loginId`, handler(async (req, res) => res.json(runtime.getLogin(req.params.loginId))));

  app.post(`${ROUTE}/logins/:loginId/code`, json, handler(async (req, res) => {
    runtime.submitCode(req.params.loginId, parseBody(codeSchema, req).code);
    return res.json({ ok: true });
  }, { mutates: true }));

  app.post(`${ROUTE}/logins/:loginId/retry`, json, handler(async (req, res) => {
    runtime.retryLogin(req.params.loginId);
    return res.json({ ok: true });
  }, { mutates: true }));

  app.delete(`${ROUTE}/logins/:loginId`, handler(async (req, res) => {
    runtime.cancelLogin(req.params.loginId);
    return res.json({ ok: true });
  }, { mutates: true }));

  app.post(`${ROUTE}/adopt`, json, handler(async (req, res) => {
    await runtime.adopt(parseBody(credentialSchema, req).credentialId);
    return res.json({ ok: true });
  }, { mutates: true }));

  app.post(`${ROUTE}/save-live`, json, handler(async (req, res) => (
    res.json(await runtime.saveLiveAsNewAccount(parseBody(saveLiveSchema, req)))
  ), { mutates: true }));

  app.post(`${ROUTE}/replace-live`, json, handler(async (req, res) => {
    await runtime.replaceLive(parseBody(credentialSchema, req).credentialId);
    return res.json({ ok: true });
  }, { mutates: true }));

  // "Use": swap the Claude login first, then let OpenCode record the new
  // active row. When OpenCode refuses, or the client goes away before an
  // answer, the previous login goes back (through the same queue as every
  // other switch, and only while the login is still the one written here).
  app.post('/api/credential/:credentialId/activate', async (req, res, next) => {
    const { credentialId } = req.params;
    let swapped;
    try {
      if (!(await runtime.isClaudeRow(credentialId))) return next();
      requireIntent(req);
      swapped = await runtime.switchForUser(credentialId);
    } catch (error) {
      return sendError(res, error);
    }
    res.once('close', () => {
      const answered = res.writableFinished && res.statusCode >= 200 && res.statusCode < 300;
      if (answered || !swapped.previousCredentialId || !swapped.writtenFingerprint) return;
      runtime.switchTo(swapped.previousCredentialId, { onlyIfLiveFingerprint: swapped.writtenFingerprint }).catch((error) => {
        logger.warn(`[claude-accounts] could not swap back after OpenCode did not take the account: ${toClaudeAccountError(error).message}`);
      });
    });
    return next();
  });

  // Removing a row drops its saved login once OpenCode agreed. The live login stays.
  app.delete('/api/credential/:credentialId', async (req, res, next) => {
    const { credentialId } = req.params;
    try {
      if (!(await runtime.isClaudeRow(credentialId))) return next();
      requireIntent(req);
    } catch (error) {
      return sendError(res, error);
    }
    res.once('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        runtime.forgetAccount(credentialId).catch((error) => {
          logger.warn(`[claude-accounts] could not delete the saved login: ${toClaudeAccountError(error).message}`);
        });
      }
    });
    return next();
  });
};
