/**
 * Tells the user when the Claude usage guard acted for them.
 *
 * The guard runs on the server (`claude-accounts/usage-guard.js`) while a Claude
 * Agent session works. It moves the login to another account before the 5-hour
 * or weekly window reaches the user's threshold, which is where paid extra usage
 * starts, so a switch of every session's account should not happen unannounced.
 * With no account left to move to it says so once, and so it does when it cannot
 * watch the live account at all (its usage cannot be read, or its login is not
 * one that was saved), because then nothing stands between the user and extra usage.
 */

import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

export const useClaudeUsageGuardNotices = (): void => {
  const { t } = useI18n();

  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'claude-usage-guard') return;
    const { guard } = event;
    if (guard.kind === 'unprotected') {
      toast.warning(t('settings.providers.claude.usageGuard.unprotected'));
      return;
    }
    if (guard.kind === 'all-over') {
      toast.warning(t('settings.providers.claude.usageGuard.toast.allOver'));
      return;
    }
    toast.info(t('settings.providers.claude.usageGuard.toast.switched', {
      account: guard.toAccount,
      window: guard.window === '5h'
        ? t('settings.providers.claude.usageGuard.window.fiveHour')
        : t('settings.providers.claude.usageGuard.window.weekly'),
      percent: guard.percent,
    }));
  }), [t]);
};
