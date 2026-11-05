import React from 'react';
import { SettingsCheckboxRow, SettingsFieldRow, SETTINGS_NUMBER_INPUT_CLASS } from '@/components/sections/shared/SettingsSection';
import { NumberInput } from '@/components/ui/number-input';
import { useI18n } from '@/lib/i18n';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { CLAUDE_USAGE_GUARD_MAX_PERCENT, CLAUDE_USAGE_GUARD_MIN_PERCENT, clampUsageThreshold } from './claudeAccounts';

interface GuardValues {
  enabled: boolean;
  fiveHour: number;
  weekly: number;
}

interface ClaudeUsageGuardSettingsProps {
  /** Accounts with a saved login; switching needs two. */
  accountCount: number;
  needsAccountsText: string;
}

/** The settings keys of what changed; a key that did not change is not sent. */
const patchOf = ({ enabled, fiveHour, weekly }: Partial<GuardValues>) => {
  const patch: Parameters<typeof updateDesktopSettings>[0] = {};
  if (enabled !== undefined) patch.claudeUsageGuardEnabled = enabled;
  if (fiveHour !== undefined) patch.claudeUsageGuardFiveHour = fiveHour;
  if (weekly !== undefined) patch.claudeUsageGuardWeekly = weekly;
  return patch;
};

/**
 * Opt-in to switching the Claude account before paid extra usage starts. With
 * extra usage on, an account at 100% of its 5-hour or weekly window is billed
 * instead of rate-limited, so limit failover never fires; the server watches
 * the usage percentages while a Claude Agent session works and moves to another
 * saved account when either window reaches its threshold
 * (`claude-accounts/usage-guard.js`). Off by default.
 */
export const ClaudeUsageGuardSettings: React.FC<ClaudeUsageGuardSettingsProps> = ({ accountCount, needsAccountsText }) => {
  const { t } = useI18n();
  const [values, setValues] = React.useState<GuardValues | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void loadDesktopSettings()
      .then((settings) => {
        if (cancelled) return;
        setValues({
          enabled: settings?.claudeUsageGuardEnabled === true,
          fiveHour: settings?.claudeUsageGuardFiveHour ?? CLAUDE_USAGE_GUARD_MAX_PERCENT,
          weekly: settings?.claudeUsageGuardWeekly ?? CLAUDE_USAGE_GUARD_MAX_PERCENT,
        });
      })
      .catch(() => {
        if (!cancelled) setValues({ enabled: false, fiveHour: CLAUDE_USAGE_GUARD_MAX_PERCENT, weekly: CLAUDE_USAGE_GUARD_MAX_PERCENT });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (values === null) return null;

  const canSwitch = accountCount > 1;
  const save = async (change: Partial<GuardValues>) => {
    const previous = values;
    setValues({ ...values, ...change });
    const result = await updateDesktopSettings(patchOf(change));
    if (!result.ok) setValues(previous);
  };

  const threshold = (key: 'fiveHour' | 'weekly', labelKey: 'settings.providers.claude.usageGuard.fiveHourLabel' | 'settings.providers.claude.usageGuard.weeklyLabel') => (
    <SettingsFieldRow label={t(labelKey)} settingsItem={`providers.claude.usage-guard.${key}`}>
      <NumberInput
        value={values[key]}
        onValueChange={(value) => void save(key === 'fiveHour' ? { fiveHour: clampUsageThreshold(value) } : { weekly: clampUsageThreshold(value) })}
        min={CLAUDE_USAGE_GUARD_MIN_PERCENT}
        max={CLAUDE_USAGE_GUARD_MAX_PERCENT}
        step={1}
        className={SETTINGS_NUMBER_INPUT_CLASS}
        aria-label={t(labelKey)}
      />
      <span className="typography-meta text-muted-foreground">%</span>
    </SettingsFieldRow>
  );

  return (
    <div className="space-y-1">
      <SettingsCheckboxRow
        checked={canSwitch && values.enabled}
        onChange={(checked) => void save({ enabled: checked })}
        disabled={!canSwitch}
        label={t('settings.providers.claude.usageGuard.label')}
        ariaLabel={t('settings.providers.claude.usageGuard.label')}
        info={t('settings.providers.claude.usageGuard.info')}
        description={canSwitch ? undefined : needsAccountsText}
        settingsItem="providers.claude.usage-guard"
      />
      {canSwitch && values.enabled ? (
        <>
          {threshold('fiveHour', 'settings.providers.claude.usageGuard.fiveHourLabel')}
          {threshold('weekly', 'settings.providers.claude.usageGuard.weeklyLabel')}
        </>
      ) : null}
    </div>
  );
};
