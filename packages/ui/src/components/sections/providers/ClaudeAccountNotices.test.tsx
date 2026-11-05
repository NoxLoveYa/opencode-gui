import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { ClaudeAccountsView } from './claudeAccounts';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event,
  MutationObserver: browser.MutationObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ClaudeAccountNotices } = await import('./ClaudeAccountNotices');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const identity = { email: 'new@example.com', orgName: null, orgId: null, accountUuid: 'acc-new', subscriptionType: null };
const view = (warnings: Array<{ code: string; credentialId?: string; liveCredentialId?: string }>): ClaudeAccountsView => ({
  status: 'ready',
  state: {
    available: true,
    accounts: {},
    liveCredentialId: 'crd_new',
    liveIdentity: identity,
    activeCredentialId: 'crd_new',
    unsavedLive: false,
    usageGuard: { enabled: false, fiveHour: 100, weekly: 100, allOver: false, unprotected: null },
    warnings,
    canAdd: true,
  },
});

const render = async (input: { view: ClaudeAccountsView; settling: boolean }) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <I18nProvider>
      <ClaudeAccountNotices
        view={input.view}
        vscode={false}
        labels={{ crd_old: 'Perso', crd_new: 'Work' }}
        onRetry={() => {}}
        busy={false}
        settling={input.settling}
      />
    </I18nProvider>,
  ));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
};

const mismatch = { code: 'active-mismatch', credentialId: 'crd_old', liveCredentialId: 'crd_new' };

test('says OpenCode and this computer disagree when they do, once nothing is settling', async () => {
  const host = await render({ view: view([mismatch]), settling: false });

  expect(host.textContent).toContain('Perso is active in OpenCode');
});

test('does not say so while a switch is under way or has just ended, however the two reads fell', async () => {
  const host = await render({ view: view([mismatch]), settling: true });

  expect(host.textContent).not.toContain('is active in OpenCode');
  // What the page always says about switching stays.
  expect(host.textContent).toContain('Switching changes the Claude login');
});

test('keeps every other warning while settling', async () => {
  const host = await render({ view: view([mismatch, { code: 'oauth-account-not-updated' }]), settling: true });

  expect(host.textContent).not.toContain('is active in OpenCode');
  expect(host.textContent).toContain('keeps showing the previous account name');
});
