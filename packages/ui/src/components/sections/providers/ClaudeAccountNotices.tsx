import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { ClaudeAccountsView } from './claudeAccounts';

interface ClaudeAccountNoticesProps {
  view: ClaudeAccountsView;
  /** VS Code runs its own OpenCode, which OpenChamber does not manage. */
  vscode: boolean;
  /** Account labels by credential id, for the warnings that name a row. */
  labels: Readonly<Record<string, string>>;
  onRetry: () => void;
  /** Saves the login nobody saved as a new account. Absent where adding accounts is not allowed. */
  onSaveLive?: () => void;
  /** A save is running. */
  busy: boolean;
  /**
   * A switch is under way or has just ended: OpenCode's list and this computer's login are
   * read at slightly different moments, so "they disagree" is not said yet.
   */
  settling: boolean;
}

/**
 * What the Claude Agent page says around its accounts: why switching is
 * unavailable, what does not add up (the active account is not the login that
 * is live, a login nobody saved), and what a switch does.
 */
export const ClaudeAccountNotices: React.FC<ClaudeAccountNoticesProps> = ({ view, vscode, labels, onRetry, onSaveLive, busy, settling }) => {
  const { t } = useI18n();

  if (vscode) {
    return <p className="typography-meta text-muted-foreground">{t('settings.providers.claude.unavailable.vscode')}</p>;
  }
  if (view.status === 'loading') return null;
  if (view.status === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="typography-meta text-[var(--status-error)]">{t('settings.providers.claude.loadFailed')}</p>
        <Button variant="outline" size="xs" className="!font-normal" onClick={onRetry}>
          {t('settings.providers.page.actions.tryAgain')}
        </Button>
      </div>
    );
  }
  if (view.status === 'unavailable') {
    if (view.reason === 'store-unreadable') {
      return <p className="typography-meta text-[var(--status-error)]">{t('settings.providers.claude.unavailable.store')}</p>;
    }
    return (
      <p className="typography-meta text-muted-foreground">
        {view.reason === 'external-opencode'
          ? t('settings.providers.claude.unavailable.external')
          : view.reason === 'unsupported-platform'
            ? t('settings.providers.claude.unavailable.platform')
            : t('settings.providers.claude.unavailable.generic')}
      </p>
    );
  }

  const { state } = view;
  const nameOf = (credentialId: string | undefined) => (credentialId ? labels[credentialId] ?? '' : '');
  const warnings = state.warnings.flatMap((warning) => {
    if (warning.code === 'active-mismatch') {
      if (settling) return [];
      return [{
        code: warning.code,
        message: t('settings.providers.claude.warning.activeMismatch', {
          account: nameOf(warning.credentialId),
          live: nameOf(warning.liveCredentialId) || state.liveIdentity?.email || '',
        }),
      }];
    }
    if (warning.code === 'live-unknown') return [{ code: warning.code, message: t('settings.providers.claude.warning.liveUnknown') }];
    if (warning.code === 'oauth-account-not-updated') return [{ code: warning.code, message: t('settings.providers.claude.warning.oauthAccountNotUpdated') }];
    return [];
  });
  // Not a warning the server lists: the usage guard has no account left to move to.
  if (state.usageGuard.allOver) warnings.push({ code: 'usage-all-over', message: t('settings.providers.claude.usageGuard.allOver') });
  if (state.usageGuard.unprotected) warnings.push({ code: 'usage-unprotected', message: t('settings.providers.claude.usageGuard.unprotected') });

  return (
    <div className="space-y-1.5">
      {warnings.map((warning) => (
        <div key={warning.code} className="flex flex-wrap items-center gap-2">
          <p className="typography-meta text-[var(--status-warning)]">{warning.message}</p>
          {warning.code === 'live-unknown' && onSaveLive ? (
            <Button variant="outline" size="xs" className="!font-normal" disabled={busy} onClick={onSaveLive}>
              {t('settings.providers.claude.unsaved.saveNew')}
            </Button>
          ) : null}
        </div>
      ))}
      <p className="typography-meta text-muted-foreground">{t('settings.providers.claude.switchingNote')}</p>
    </div>
  );
};
