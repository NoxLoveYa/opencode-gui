import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { ClaudeRowsInfo, ClaudeSavedAccount } from './claudeAccounts';
import type { CredentialConnection } from './providerAuth';

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
const { ProviderAccounts } = await import('./ProviderAccounts');

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

const NOW = Date.parse('2026-11-05T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const row = (id: string, label: string): CredentialConnection => ({ type: 'credential', id, label, method: 'external' });
const perso = row('crd_perso', 'Perso');
const work = row('crd_work', 'Work');
const saved = (overrides: Partial<ClaudeSavedAccount['identity']> = {}, refreshTokenExpiresAt: number | null = NOW + 30 * DAY): ClaudeSavedAccount => ({
  identity: { email: 'me@example.com', orgName: 'Acme', orgId: 'org-1', accountUuid: 'acc-1', subscriptionType: 'max', ...overrides },
  savedAt: NOW,
  refreshTokenExpiresAt,
  usage: null,
});

const render = async (input: {
  rows: CredentialConnection[];
  claude: Partial<ClaudeRowsInfo> & Pick<ClaudeRowsInfo, 'accounts'>;
  activeId?: string | null;
}) => {
  const calls: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <I18nProvider>
      <ProviderAccounts
        connections={input.rows}
        activeId={input.activeId ?? perso.id}
        unusedIds={new Set()}
        busyId={null}
        canSwitch
        showActive
        onActivate={(account) => calls.push(`use:${account.id}`)}
        onRename={() => {}}
        onRemove={() => {}}
        claude={{
          now: NOW,
          adoptTargetId: null,
          canSignIn: true,
          onSignIn: (account) => calls.push(`sign-in:${account.id}`),
          onAdopt: (account) => calls.push(`adopt:${account.id}`),
          ...input.claude,
        }}
      />
    </I18nProvider>,
  ));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  return {
    host,
    calls,
    button,
    click: async (node: HTMLElement | undefined) => {
      if (!node) throw new Error('Missing element');
      await act(async () => node.click());
    },
  };
};

test('a row with a saved login shows who it belongs to, and Use works', async () => {
  const view = await render({ rows: [perso, work], claude: { accounts: { [perso.id]: saved(), [work.id]: saved({ email: 'work@example.com', orgName: null, subscriptionType: 'pro' }) } } });

  expect(view.host.textContent).toContain('me@example.com · Acme · max');
  expect(view.host.textContent).toContain('work@example.com · pro');
  expect(view.host.textContent).not.toContain('Login not saved');

  await view.click(view.button('Use'));
  expect(view.calls).toEqual(['use:crd_work']);
});

test('a row shows the usage the server last saw under who it belongs to', async () => {
  const withUsage: ClaudeSavedAccount = {
    ...saved(),
    usage: { fiveHour: { percent: 86.6, resetsAt: NOW + DAY }, weekly: { percent: 42, resetsAt: NOW + 3 * DAY }, readAt: NOW - 3 * 60_000 },
  };
  const view = await render({ rows: [perso, work], claude: { accounts: { [perso.id]: withUsage, [work.id]: saved({ email: 'work@example.com' }) } } });

  expect(view.host.textContent).toContain('me@example.com · Acme · max · 5h 87% · week 42% · 3 minutes ago');
  // A row nothing was read for shows no age either.
  expect(view.host.textContent).not.toContain('work@example.com · 5h');
  expect(view.host.textContent).not.toContain('work@example.com · pro · ');
});

const NOT_LOGGED_IN = 'Claude Code is not logged in. Run `claude auth login` in a terminal.';
const needsAuth = (connection: CredentialConnection): CredentialConnection => ({
  ...connection,
  status: { status: 'needs_auth', message: NOT_LOGGED_IN, url: 'https://claude.ai/login' },
});

test('a row with a saved login shows who it belongs to even when OpenCode says Claude Code is not logged in', async () => {
  const view = await render({ rows: [needsAuth(perso), work], claude: { accounts: { [perso.id]: saved(), [work.id]: saved({ email: 'work@example.com' }) } } });

  expect(view.host.textContent).toContain('me@example.com · Acme · max');
  expect(view.host.textContent).not.toContain(NOT_LOGGED_IN);
  // OpenCode's own sign-in button would lead to its login, not to the saved one.
  expect(view.button('Sign in')).toBe(undefined);
});

test('a row without a saved login shows OpenCode\'s message and its sign-in button', async () => {
  const view = await render({ rows: [needsAuth(perso), work], claude: { accounts: { [work.id]: saved() } } });

  expect(view.host.textContent).toContain(NOT_LOGGED_IN);
  expect(view.host.textContent).not.toContain('Login not saved');
});

test('a row without a saved login says so, offers Sign in, and cannot be used', async () => {
  const view = await render({ rows: [perso, work], claude: { accounts: { [perso.id]: saved() } } });

  expect(view.host.textContent).toContain('Login not saved');
  expect(view.button('Use')?.hasAttribute('disabled')).toBe(true);
  await view.click(view.button('Sign in'));
  expect(view.calls).toEqual(['sign-in:crd_work']);
});

test('the active row without a login offers to save the current one, when the live login is known', async () => {
  const view = await render({ rows: [perso, work], claude: { accounts: {}, adoptTargetId: perso.id } });

  expect(view.button('Save current login')).not.toBe(undefined);
  // The other row signs in; saving the current login belongs to the active one only.
  expect(view.button('Sign in')).not.toBe(undefined);
  await view.click(view.button('Save current login'));
  expect(view.calls).toEqual(['adopt:crd_perso']);
});

test('a login that ends within a week is flagged with its date', async () => {
  const view = await render({ rows: [perso], claude: { accounts: { [perso.id]: saved({}, NOW + 3 * DAY) } } });

  expect(view.host.textContent).toContain('Sign in again before');
});

test('enterprise mode offers no sign-in and no save', async () => {
  const view = await render({ rows: [perso, work], claude: { accounts: {}, adoptTargetId: perso.id, canSignIn: false } });

  expect(view.host.textContent).toContain('Login not saved');
  expect(view.button('Sign in')).toBe(undefined);
  expect(view.button('Save current login')).toBe(undefined);
});
