import React from 'react';
import type { ConnectionInfo } from '@opencode/client';
import { SETTINGS_ICON_BUTTON_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { describeReadingAge, summarizeClaudeRow, type ClaudeRowSummary, type ClaudeRowsInfo } from './claudeAccounts';
import { connectionNeedsAuth, type CredentialConnection } from './providerAuth';

interface ProviderAccountsProps {
  /** Stored credentials first, then environment variables the server can see. */
  connections: readonly ConnectionInfo[];
  /** The one credential requests go through, when a stored credential is in use. */
  activeId: string | null;
  /**
   * Credentials stored under an integration the provider does not use right now
   * (OpenCode Go keys while the Console sign-in serves Go). Removable, never switchable.
   */
  unusedIds: ReadonlySet<string>;
  /** Credential id with a write in flight; every account action waits for it. */
  busyId: string | null;
  /**
   * Judged over all of the provider's accounts, which may be split across
   * several lists: whether an idle account offers Use, and whether the active
   * one carries its Active mark.
   */
  canSwitch: boolean;
  showActive: boolean;
  onActivate: (account: CredentialConnection) => void;
  onRename: (account: CredentialConnection, label: string) => void;
  onRemove: (account: CredentialConnection) => void;
  /** Claude Agent only: each row's saved login, and the actions around it. */
  claude?: ClaudeRowsInfo;
}

const AccountTile: React.FC<{ icon: IconName }> = ({ icon }) => (
  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-muted)] text-muted-foreground">
    <Icon name={icon} className="size-4" />
  </span>
);

/**
 * The line under an account: what OpenCode reported when the connection needs
 * a new sign-in, otherwise how the account connects.
 */
const AccountSubtitle: React.FC<{ connection: ConnectionInfo; fallback: string }> = ({ connection, fallback }) => (
  connectionNeedsAuth(connection) && connection.status ? (
    <div className="typography-micro text-[var(--status-warning)] break-words">{connection.status.message}</div>
  ) : (
    <div className="typography-micro text-muted-foreground">{fallback}</div>
  )
);

/** The line under a Claude Agent account: who the saved login belongs to, or that none is saved. */
const ClaudeRowSubtitle: React.FC<{ summary: ClaudeRowSummary; now: number }> = ({ summary, now }) => {
  const { t } = useI18n();
  if (summary.kind === 'missing') {
    return <div className="typography-micro text-[var(--status-warning)]">{t('settings.providers.claude.loginNotSaved')}</div>;
  }
  const usage = [
    summary.usage.fiveHour === null ? null : t('settings.providers.claude.usage.fiveHour', { percent: summary.usage.fiveHour }),
    summary.usage.weekly === null ? null : t('settings.providers.claude.usage.weekly', { percent: summary.usage.weekly }),
  ].filter((part): part is string => part !== null).join(' · ');
  // How old the numbers are, so a stale one does not pass for the present.
  const age = usage && summary.usage.readAt !== null
    ? describeReadingAge(summary.usage.readAt, now, getCurrentIntlLocale())
    : '';
  const lead = [summary.identity, usage, age].filter(Boolean).join(' · ');
  return (
    <div className="typography-micro break-words">
      <span className="text-muted-foreground">{lead}</span>
      {summary.expiresAt !== null ? (
        <span className="text-[var(--status-warning)]">
          {lead ? ' · ' : ''}
          {t('settings.providers.claude.refreshExpiring', {
            date: new Date(summary.expiresAt).toLocaleDateString(getCurrentIntlLocale(), { dateStyle: 'medium' }),
          })}
        </span>
      ) : null}
    </div>
  );
};

/** Opens the page OpenCode named for signing in again (an SSO login, for one). */
const SignInAgainButton: React.FC<{ connection: ConnectionInfo; account: string }> = ({ connection, account }) => {
  const { t } = useI18n();
  const url = connectionNeedsAuth(connection) ? connection.status?.url : undefined;
  if (!url) return null;
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={() => { void openExternalUrl(url); }}
      aria-label={t('settings.providers.accounts.signInAria', { account })}
    >
      {t('settings.providers.accounts.signIn')}
    </Button>
  );
};

const RenameField: React.FC<{
  initial: string;
  onSave: (label: string) => void;
  onCancel: () => void;
}> = ({ initial, onSave, onCancel }) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState(initial);
  const trimmed = value.trim();
  const save = () => {
    if (trimmed.length === 0 || trimmed === initial) {
      onCancel();
      return;
    }
    onSave(trimmed);
  };

  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        aria-label={t('settings.providers.accounts.nameAria')}
        className="h-8 max-w-[18rem]"
      />
      <Button type="submit" size="xs">{t('settings.providers.accounts.save')}</Button>
      <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
        {t('settings.providers.page.actions.cancel')}
      </Button>
    </form>
  );
};

/** Stored accounts and environment connections for one provider. */
export const ProviderAccounts: React.FC<ProviderAccountsProps> = ({
  connections,
  activeId,
  unusedIds,
  busyId,
  canSwitch,
  showActive,
  onActivate,
  onRename,
  onRemove,
  claude,
}) => {
  const { t } = useI18n();
  const [renamingId, setRenamingId] = React.useState<string | null>(null);

  return (
    <div className="divide-y divide-[var(--surface-subtle)]">
      {connections.map((connection) => {
        if (connection.type === 'env') {
          return (
            <div key={`env:${connection.name}`} className="flex min-w-0 items-center gap-3 py-2.5">
              <AccountTile icon="terminal-box" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono typography-ui-label text-foreground">{connection.name}</div>
                <AccountSubtitle connection={connection} fallback={t('settings.providers.accounts.environment')} />
              </div>
              <SignInAgainButton connection={connection} account={connection.name} />
            </div>
          );
        }

        const active = connection.id === activeId;
        const unused = unusedIds.has(connection.id);
        const busy = busyId !== null;
        const claudeSummary = claude ? summarizeClaudeRow(connection.id, claude.accounts, claude.now) : null;
        const loginMissing = claudeSummary?.kind === 'missing';
        const methodLabel = connection.method === 'oauth'
          ? (unused ? t('settings.providers.accounts.method.oauthUnused') : t('settings.providers.accounts.method.oauth'))
          : connection.method === 'external'
            ? (unused ? t('settings.providers.accounts.method.externalUnused') : t('settings.providers.accounts.method.external'))
            : (unused ? t('settings.providers.accounts.method.keyUnused') : t('settings.providers.accounts.method.key'));
        // An external credential (a cloud CLI login or profile) lives outside OpenCode's store.
        const methodIcon = connection.method === 'oauth' ? 'user-3' : connection.method === 'external' ? 'terminal-box' : 'key';

        // The row's right click opens the same menu as its ⋯ button.
        return (
          <ContextMenu key={connection.id} disabled={busy || renamingId === connection.id}>
          <ContextMenuTrigger render={<div className={cn('flex min-w-0 items-center gap-3 py-2.5', unused && 'opacity-60')} />}>
            <AccountTile icon={methodIcon} />
            {renamingId === connection.id ? (
              <RenameField
                initial={connection.label}
                onCancel={() => setRenamingId(null)}
                onSave={(label) => {
                  setRenamingId(null);
                  onRename(connection, label);
                }}
              />
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span dir="auto" className="truncate typography-ui-label font-medium text-foreground">{connection.label}</span>
                    {showActive && active ? (
                      <span className="shrink-0 rounded-full bg-[var(--interactive-selection)] px-2 py-px text-[0.625rem] font-medium text-[var(--interactive-selection-foreground)]">
                        {t('settings.providers.accounts.active')}
                      </span>
                    ) : null}
                  </div>
                  {/* A saved login says who the row is, whatever OpenCode's own check of Claude Code reports (it can be stale). */}
                  {claudeSummary && (claudeSummary.kind === 'saved' || !connectionNeedsAuth(connection))
                    ? <ClaudeRowSubtitle summary={claudeSummary} now={claude?.now ?? 0} />
                    : <AccountSubtitle connection={connection} fallback={methodLabel} />}
                </div>
                {claudeSummary?.kind === 'saved' ? null : <SignInAgainButton connection={connection} account={connection.label} />}
                {claude && loginMissing && claude.canSignIn ? (
                  claude.adoptTargetId === connection.id ? (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      onClick={() => claude.onAdopt(connection)}
                      aria-label={t('settings.providers.claude.saveCurrentAria', { account: connection.label })}
                    >
                      {t('settings.providers.claude.saveCurrent')}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      onClick={() => claude.onSignIn(connection)}
                      aria-label={t('settings.providers.accounts.signInAria', { account: connection.label })}
                    >
                      {t('settings.providers.accounts.signIn')}
                    </Button>
                  )
                ) : null}
                {canSwitch && !active && !unused ? (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busy || loginMissing}
                    title={loginMissing ? t('settings.providers.claude.useNeedsLogin') : undefined}
                    onClick={() => onActivate(connection)}
                    aria-label={t('settings.providers.accounts.useAria', { account: connection.label })}
                  >
                    {busyId === connection.id ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                    {t('settings.providers.accounts.use')}
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      className={cn(SETTINGS_ICON_BUTTON_CLASS, 'shrink-0')}
                      aria-label={t('settings.providers.accounts.menuAria', { account: connection.label })}
                    >
                      <Icon name="more" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {claude?.canSignIn ? (
                      <DropdownMenuItem onSelect={() => claude.onSignIn(connection)}>
                        <Icon name="user-3" className="size-4" />
                        {t('settings.providers.claude.signInAgain')}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onSelect={() => setRenamingId(connection.id)}>
                      <Icon name="pencil" className="size-4" />
                      {t('settings.providers.accounts.rename')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => onRemove(connection)}
                    >
                      <Icon name="delete-bin" className="size-4" />
                      {t('settings.providers.accounts.remove')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => setRenamingId(connection.id)}>
              <Icon name="pencil" className="size-4" />
              {t('settings.providers.accounts.rename')}
            </ContextMenuItem>
            <ContextMenuItem className="text-destructive focus:text-destructive" onClick={() => onRemove(connection)}>
              <Icon name="delete-bin" className="size-4" />
              {t('settings.providers.accounts.remove')}
            </ContextMenuItem>
          </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
};
