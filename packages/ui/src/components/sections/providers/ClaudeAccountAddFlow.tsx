import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import {
  cancelClaudeLogin,
  ClaudeAccountsRequestError,
  claudeLoginErrorKey,
  fetchClaudeLogin,
  retryClaudeLogin,
  startClaudeLogin,
  submitClaudeLoginCode,
  type ClaudeLoginRequest,
  type ClaudeLoginStatus,
} from './claudeAccounts';

interface ClaudeAccountAddFlowProps {
  /** Signs in again under this row. Without it the flow adds a new account. */
  credentialId?: string;
  /** The sign-in finished and its login is saved. */
  onFinished: () => void;
  onCancel: () => void;
}

type Flow =
  | { phase: 'form' }
  | { phase: 'starting' }
  | { phase: 'running'; loginId: string; status: ClaudeLoginStatus }
  /** `retryable`: the login was captured and kept, so only its account row has to be created again. */
  | { phase: 'failed'; code: string; label: string | undefined; loginId: string | null; retryable: boolean };

/** How often a running sign-in is re-read. */
const POLL_INTERVAL_MS = 1500;

/**
 * Signs in to a Claude account without touching the login Claude Code uses:
 * the server runs `claude auth login` in a temporary folder and keeps the
 * result as a saved login. The page shows the sign-in link, takes a pasted
 * code, and follows the server until the account is saved.
 *
 * Leaving the page while a sign-in runs cancels it.
 */
export const ClaudeAccountAddFlow: React.FC<ClaudeAccountAddFlowProps> = ({ credentialId, onFinished, onCancel }) => {
  const { t } = useI18n();
  const [flow, setFlow] = React.useState<Flow>(credentialId ? { phase: 'starting' } : { phase: 'form' });
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [code, setCode] = React.useState('');
  const [submittingCode, setSubmittingCode] = React.useState(false);
  /** The login being followed. Clearing it stops the poll at its next tick. */
  const activeLoginRef = React.useRef<string | null>(null);
  const unmountedRef = React.useRef(false);

  React.useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      const pending = activeLoginRef.current;
      if (pending) void cancelClaudeLogin(pending).catch(() => undefined);
    };
  }, []);

  const follow = React.useCallback(async (loginId: string) => {
    activeLoginRef.current = loginId;
    while (activeLoginRef.current === loginId) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (activeLoginRef.current !== loginId) return;
      let status: ClaudeLoginStatus;
      try {
        status = await fetchClaudeLogin(loginId);
      } catch (error) {
        if (activeLoginRef.current !== loginId) return;
        console.error('Failed to read the Claude sign-in:', error);
        activeLoginRef.current = null;
        setFlow({ phase: 'failed', code: error instanceof ClaudeAccountsRequestError ? error.code : 'unknown', label: undefined, loginId, retryable: false });
        return;
      }
      if (activeLoginRef.current !== loginId) return;
      if (status.state === 'done') {
        activeLoginRef.current = null;
        toast.success(credentialId
          ? t('settings.providers.claude.add.signedInAgain')
          : t('settings.providers.claude.add.added'));
        onFinished();
        return;
      }
      if (status.state === 'cancelled') {
        activeLoginRef.current = null;
        onCancel();
        return;
      }
      if (status.state === 'failed') {
        activeLoginRef.current = null;
        setFlow({ phase: 'failed', code: status.error?.code ?? 'unknown', label: status.error?.label, loginId, retryable: status.retryable });
        return;
      }
      setFlow({ phase: 'running', loginId, status });
    }
  }, [credentialId, onCancel, onFinished, t]);

  const start = React.useCallback(async () => {
    setFlow({ phase: 'starting' });
    setCode('');
    try {
      const input: ClaudeLoginRequest = {};
      if (credentialId) input.credentialId = credentialId;
      if (name.trim()) input.label = name.trim();
      if (email.trim()) input.email = email.trim();
      const loginId = await startClaudeLogin(input);
      if (unmountedRef.current) {
        void cancelClaudeLogin(loginId).catch(() => undefined);
        return;
      }
      setFlow({ phase: 'running', loginId, status: { state: 'starting', url: null, error: null, credentialId: null, retryable: false } });
      await follow(loginId);
    } catch (error) {
      console.error('Failed to start the Claude sign-in:', error);
      if (unmountedRef.current) return;
      setFlow({ phase: 'failed', code: error instanceof ClaudeAccountsRequestError ? error.code : 'unknown', label: undefined, loginId: null, retryable: false });
    }
  }, [credentialId, email, follow, name]);

  /** Creates the account row again for a login that was captured, without signing in a second time. */
  const retry = React.useCallback(async (loginId: string) => {
    setFlow({ phase: 'running', loginId, status: { state: 'verifying', url: null, error: null, credentialId: null, retryable: false } });
    try {
      await retryClaudeLogin(loginId);
      await follow(loginId);
    } catch (error) {
      console.error('Failed to retry the Claude sign-in:', error);
      if (unmountedRef.current) return;
      setFlow({ phase: 'failed', code: error instanceof ClaudeAccountsRequestError ? error.code : 'unknown', label: undefined, loginId: null, retryable: false });
    }
  }, [follow]);

  // A sign-in again has nothing to ask first.
  const autoStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (!credentialId || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void start();
    // Once per mount: a later render must not restart a sign-in the user cancelled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialId]);

  const cancel = () => {
    const pending = activeLoginRef.current;
    activeLoginRef.current = null;
    if (pending) void cancelClaudeLogin(pending).catch(() => undefined);
    onCancel();
  };

  const copyLink = async (url: string) => {
    const result = await copyTextToClipboard(url);
    if (result.ok) toast.success(t('settings.providers.page.toast.oauthLinkCopied'));
    else toast.error(t('settings.providers.page.toast.oauthLinkCopyFailed'));
  };

  const submitCode = async (loginId: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setSubmittingCode(true);
    try {
      await submitClaudeLoginCode(loginId, trimmed);
      setCode('');
    } catch (error) {
      console.error('Failed to send the Claude sign-in code:', error);
      toast.error(t('settings.providers.claude.add.error.generic'));
    } finally {
      setSubmittingCode(false);
    }
  };

  if (flow.phase === 'form') {
    return (
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label className="block space-y-1">
          <span className="typography-meta text-muted-foreground">{t('settings.providers.claude.add.nameLabel')}</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} className="max-w-[22rem]" />
        </label>
        <label className="block space-y-1">
          <span className="typography-meta text-muted-foreground">{t('settings.providers.claude.add.emailLabel')}</span>
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="max-w-[22rem]" />
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="outline" size="xs" className="!font-normal">
            {t('settings.providers.claude.add.start')}
          </Button>
          <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={cancel}>
            {t('settings.providers.page.actions.cancel')}
          </Button>
        </div>
      </form>
    );
  }

  if (flow.phase === 'failed') {
    return (
      <div className="space-y-2">
        <p className="typography-meta text-[var(--status-error)]">
          {t(claudeLoginErrorKey(flow.code, flow.label), { label: flow.label ?? '' })}
        </p>
        <div className="flex items-center gap-2">
          {flow.code === 'enterprise_mode' ? null : (
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => (flow.retryable && flow.loginId ? void retry(flow.loginId) : void start())}
            >
              {t('settings.providers.page.actions.tryAgain')}
            </Button>
          )}
          <Button variant="ghost" size="xs" className="!font-normal" onClick={cancel}>
            {t('settings.providers.page.actions.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  if (flow.phase === 'starting') {
    return (
      <p className="typography-meta text-muted-foreground flex items-center gap-2">
        <Spinner className="h-3.5 w-3.5" />
        {t('settings.providers.claude.add.starting')}
      </p>
    );
  }

  const { status } = flow;
  const verifying = status.state === 'verifying';
  const waiting = status.state === 'waiting-browser' || status.state === 'waiting-code';
  return (
    <div className="space-y-3">
      {status.url ? (
        <div className="flex items-center gap-2">
          <Input
            value={status.url}
            readOnly
            aria-label={t('settings.providers.page.auth.oauth.linkLabel')}
            className="text-xs text-muted-foreground"
          />
          <div className="flex gap-1 shrink-0">
            <Button variant="outline" size="xs" className="!font-normal" onClick={() => void openExternalUrl(status.url ?? '')}>
              {t('settings.providers.page.actions.open')}
            </Button>
            <Button variant="outline" size="xs" className="!font-normal" onClick={() => void copyLink(status.url ?? '')}>
              {t('settings.providers.page.actions.copy')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <p className="typography-meta text-muted-foreground flex items-center gap-2">
          <Spinner className="h-3.5 w-3.5" />
          {verifying
            ? t('settings.providers.claude.add.verifying')
            : waiting
              ? t('settings.providers.claude.add.waiting')
              : t('settings.providers.claude.add.starting')}
        </p>
        <Button variant="ghost" size="xs" className="!font-normal shrink-0" onClick={cancel} disabled={verifying}>
          {t('settings.providers.page.actions.cancel')}
        </Button>
      </div>

      {waiting ? (
        <>
          <p className="typography-meta text-muted-foreground">{t('settings.providers.claude.add.browserTip')}</p>
          <p className="typography-meta text-muted-foreground">{t('settings.providers.claude.add.codeHint')}</p>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCode(flow.loginId);
            }}
          >
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
              className="font-mono text-xs"
              disabled={submittingCode}
            />
            <Button type="submit" size="xs" className="!font-normal shrink-0" disabled={submittingCode || code.trim().length === 0}>
              {submittingCode ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
            </Button>
          </form>
        </>
      ) : null}
    </div>
  );
};
