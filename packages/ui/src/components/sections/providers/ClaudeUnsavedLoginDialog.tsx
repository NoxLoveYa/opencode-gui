import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';

interface ClaudeUnsavedLoginDialogProps {
  /** The account Use was pressed on; the dialog is closed without one. */
  accountLabel: string | null;
  /** The saving or the replacing the user chose is running. */
  busy: boolean;
  /** Saves the live login as a new account, then switches. Absent where adding accounts is not allowed. */
  onSaveNew?: () => void;
  /** Why saving is not offered, when it cannot be (the login does not say whose it is). */
  saveNewBlockedReason?: string;
  onReplace: () => void;
  onCancel: () => void;
}

/**
 * Use was pressed while a Claude login nobody saved is active on the computer.
 * Switching would remove it, so the user chooses: keep it as a new account
 * first, replace it (the server keeps a backup of the last few), or stay.
 */
export const ClaudeUnsavedLoginDialog: React.FC<ClaudeUnsavedLoginDialogProps> = ({ accountLabel, busy, onSaveNew, saveNewBlockedReason, onReplace, onCancel }) => {
  const { t } = useI18n();
  return (
    <Dialog open={accountLabel !== null} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.providers.claude.unsaved.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.providers.claude.unsaved.description', { account: accountLabel ?? '' })}
          </DialogDescription>
          {saveNewBlockedReason ? <p className="typography-meta text-muted-foreground">{saveNewBlockedReason}</p> : null}
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="outline" autoFocus disabled={busy} onClick={onCancel}>
            {t('settings.providers.page.actions.cancel')}
          </Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={onReplace}>
            {t('settings.providers.claude.unsaved.replace')}
          </Button>
          {onSaveNew ? (
            <Button size="sm" disabled={busy} onClick={onSaveNew}>
              {t('settings.providers.claude.unsaved.saveNewAndUse')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
