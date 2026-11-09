import React from 'react';
import { toast } from '@/components/ui/toast';
import { useKeybind } from '@/hooks/useKeybind';
import { isElectronShell, isVSCodeRuntime, reportDesktopNotificationSoundCoverage } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { onHostSurfaceSeen } from '@/lib/surfaceAttention';
import { agentActivity } from './agentActivity';
import { soundEngine } from './engine';
import { isAnySoundWanted } from './gate';
import { coveredNotificationKinds } from './nativeNotifications';
import { soundReminders } from './reminders';
import { soundSignals } from './signals';
import { followSoundSettingsStorage, useSoundSettingsStore } from './soundSettingsStore';
import { turnEndTracker } from './turnEnd';
import { resetWorkspaceSounds, startWorkspaceSounds } from './workspaceSources';

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;

const reportCoverage = (coveredKinds: string): void => {
  reportDesktopNotificationSoundCoverage(coveredKinds ? coveredKinds.split(',') : []);
};

/**
 * Starts the engine once per window. Mounted by the effects every runtime
 * shell renders (web, desktop, the mini chat, VS Code and mobile), so it owns
 * what the whole window needs: audio unlock, the mute shortcut, following
 * settings changed in another window, the listeners for agent events and the
 * reminder, and the reset on a runtime switch.
 */
export const useSoundSystem = (): void => {
  const { t } = useI18n();
  const isVSCode = isVSCodeRuntime();
  const soundWanted = useSoundSettingsStore((state) => isAnySoundWanted(state, { isVSCode }));
  const status = React.useSyncExternalStore(soundEngine.subscribe, soundEngine.getStatus);
  // One string, so a settings change that leaves the covered kinds alone renders nothing.
  const coveredKinds = useSoundSettingsStore((state) => coveredNotificationKinds(state, status).join(','));
  const coveredKindsRef = React.useRef('');

  // The Electron shell allows audio without a gesture. Its context runs from
  // the start, so the window can say at once that it covers notifications; a
  // browser would log a warning for a context created before a gesture.
  React.useEffect(() => {
    if (soundWanted && status === 'locked' && isElectronShell()) soundEngine.probe();
  }, [soundWanted, status]);

  // Browsers keep audio locked until a gesture. While some sound could play
  // and audio is still locked, the first click, key or touch unlocks it; the
  // listeners are gone as soon as it is, and never installed while every
  // sound is off or muted.
  React.useEffect(() => {
    if (!soundWanted || status !== 'locked') return;
    const unlock = () => {
      void soundEngine.unlock();
    };
    for (const type of UNLOCK_EVENTS) document.addEventListener(type, unlock, { capture: true, passive: true });
    return () => {
      for (const type of UNLOCK_EVENTS) document.removeEventListener(type, unlock, { capture: true });
    };
  }, [soundWanted, status]);

  // Another window changed the settings (muting in one tab mutes the rest,
  // the mini chat follows the main window).
  React.useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      void followSoundSettingsStorage(event);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    soundSignals.reset();
    turnEndTracker.reset();
    soundReminders.reset();
    agentActivity.reset();
    resetWorkspaceSounds();
    // The shell matches the report to the instance a notification came from; this window now shows another.
    reportCoverage(coveredKindsRef.current);
  }), []);

  // Turn ends come from the live status transitions, and a reminder ends when
  // the user comes back to the window and sees the session.
  React.useEffect(() => turnEndTracker.start(), []);
  // Terminal, git, pull request, usage and connection events.
  React.useEffect(() => startWorkspaceSounds(), []);
  React.useEffect(() => {
    const recheck = () => soundReminders.recheck();
    window.addEventListener('focus', recheck);
    const stopHostReports = onHostSurfaceSeen(recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      stopHostReports();
    };
  }, []);

  // The desktop shell shows a native notification without the OS sound when
  // this window plays an OpenChamber sound for its kind. A window that goes
  // away covers nothing; the shell also forgets it on close and navigation.
  React.useEffect(() => {
    coveredKindsRef.current = coveredKinds;
    reportCoverage(coveredKinds);
  }, [coveredKinds]);
  React.useEffect(() => () => reportCoverage(''), []);

  useKeybind('toggle_sounds_mute', () => {
    useSoundSettingsStore.getState().toggleMuted();
    toast.info(useSoundSettingsStore.getState().muted ? t('sounds.toast.muted') : t('sounds.toast.unmuted'));
  });
};
