import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

import { OpenChamberVisualSettings } from './OpenChamberVisualSettings';

// SAFETY: This render path only reads the optional terminal methods, so no other runtime API can be called.
const runtimeAPIs = { terminal: {} } as RuntimeAPIs;

describe('OpenChamberVisualSettings', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let initialAnimatedActivityIndicators: boolean;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;

  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'];

  beforeEach(() => {
    windowInstance = new Window();
    initialAnimatedActivityIndicators = useSessionDisplayStore.getState().animatedActivityIndicators;
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      useSessionDisplayStore.setState({ animatedActivityIndicators: initialAnimatedActivityIndicators });
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  test('renders session activity when it is the only visible setting', async () => {
    await act(async () => root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <ThemeSystemProvider>
          <I18nProvider>
            <OpenChamberVisualSettings visibleSettings={['animatedActivityIndicators']} />
          </I18nProvider>
        </ThemeSystemProvider>
      </RuntimeAPIContext.Provider>,
    ));

    expect(host.querySelector('[data-settings-item="appearance.session-activity"]')).not.toBeNull();
  });

  test('renders widget corners and toggles the square override', async () => {
    const initial = useUIStore.getState().widgetCorners;
    try {
      await act(async () => root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <OpenChamberVisualSettings visibleSettings={['widgetCorners']} />
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      ));

      expect(host.querySelector('[data-settings-item="appearance.widget-corners"]')).not.toBeNull();
      const chips = Array.from(host.querySelectorAll('[aria-pressed]'), (el) => el.textContent);
      expect(chips).toContain('Round');
      expect(chips).toContain('Squared');
      await act(async () => {
        useUIStore.getState().setWidgetCorners('square');
      });
      expect(document.documentElement.getAttribute('data-widget-corners')).toBe('square');
      await act(async () => {
        useUIStore.getState().setWidgetCorners('round');
      });
      expect(document.documentElement.hasAttribute('data-widget-corners')).toBe(false);
    } finally {
      useUIStore.setState({ widgetCorners: initial });
      useUIStore.getState().applyWidgetCorners();
    }
  });
});
