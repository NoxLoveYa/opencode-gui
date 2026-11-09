/**
 * The two shared controls the Sounds page leans on: a slider that writes once
 * on release, and a checkbox row whose trailing controls are not part of the
 * toggle.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

// React reads the DOM globals when it loads, so they come first.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  Event: browser.Event,
  FocusEvent: browser.FocusEvent,
  MouseEvent: browser.MouseEvent,
  KeyboardEvent: browser.KeyboardEvent,
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { SettingsCheckboxRow, SettingsRangeSlider } = await import('./SettingsSection');

const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);

afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});

const mount = async (node: React.ReactNode) => {
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>);
    await Promise.resolve();
  });
};

const slider = (): HTMLInputElement => {
  const input = container.querySelector('input[type="range"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('no slider');
  return input;
};

/** Moves the thumb the way the browser does: the value changes, then `input` fires. */
const drag = async (input: HTMLInputElement, value: number) => {
  // React tracks the value property; the prototype's setter keeps its tracker from swallowing the event.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const fire = async (target: Element, type: string) => {
  await act(async () => {
    target.dispatchEvent(new Event(type, { bubbles: true }));
  });
};

const readout = () => container.textContent ?? '';

describe('SettingsRangeSlider', () => {
  const Slider: React.FC<{ value: number; onCommit: (value: number) => void }> = ({ value, onCommit }) => (
    <SettingsRangeSlider value={value} onCommit={onCommit} min={0} max={100} ariaLabel="Volume" />
  );

  test('follows the drag on screen and writes once, on release', async () => {
    const commits: number[] = [];
    await mount(<Slider value={50} onCommit={(value) => commits.push(value)} />);
    for (const value of [55, 60, 65, 70]) await drag(slider(), value);
    expect(commits).toEqual([]);
    expect(readout()).toContain('70%');

    await fire(slider(), 'change');
    expect(commits).toEqual([70]);
  });

  test('writes nothing when the thumb comes back to the stored value', async () => {
    const commits: number[] = [];
    await mount(<Slider value={50} onCommit={(value) => commits.push(value)} />);
    await drag(slider(), 80);
    await drag(slider(), 50);
    await fire(slider(), 'pointerup');
    await fire(slider(), 'change');
    expect(commits).toEqual([]);
  });

  test('a drag that ends on its start value leaves no draft over a later change to the setting', async () => {
    await mount(<Slider value={50} onCommit={() => undefined} />);
    await drag(slider(), 80);
    await drag(slider(), 50);
    await fire(slider(), 'pointerup');
    // Another window changes the setting.
    await mount(<Slider value={20} onCommit={() => undefined} />);
    expect(readout()).toContain('20%');
    expect(slider().value).toBe('20');
  });

  test('losing focus on the stored value drops the draft too', async () => {
    await mount(<Slider value={50} onCommit={() => undefined} />);
    await drag(slider(), 90);
    await drag(slider(), 50);
    await fire(slider(), 'blur');
    await mount(<Slider value={30} onCommit={() => undefined} />);
    expect(readout()).toContain('30%');
  });

  test('releasing on a different value keeps showing it until the change is written', async () => {
    const commits: number[] = [];
    await mount(<Slider value={50} onCommit={(value) => commits.push(value)} />);
    await drag(slider(), 75);
    await fire(slider(), 'pointerup');
    expect(readout()).toContain('75%');
    await fire(slider(), 'change');
    expect(commits).toEqual([75]);
  });
});

describe('SettingsCheckboxRow control', () => {
  const Row: React.FC<{ onChange: (checked: boolean) => void; onControl: () => void }> = ({ onChange, onControl }) => (
    <SettingsCheckboxRow
      checked={false}
      onChange={onChange}
      label="Typing"
      ariaLabel="Typing"
      control={<button type="button" data-testid="control" onClick={onControl}>Preview</button>}
    />
  );

  const click = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  test('pressing a control runs it and does not toggle the checkbox', async () => {
    const toggles: boolean[] = [];
    let pressed = 0;
    await mount(<Row onChange={(checked) => toggles.push(checked)} onControl={() => { pressed += 1; }} />);
    const control = container.querySelector('[data-testid="control"]');
    if (!control) throw new Error('no control');
    await click(control);
    expect(pressed).toBe(1);
    expect(toggles).toEqual([]);
  });

  test('pressing the label still toggles it', async () => {
    const toggles: boolean[] = [];
    await mount(<Row onChange={(checked) => toggles.push(checked)} onControl={() => undefined} />);
    const row = container.querySelector('[role="button"][aria-pressed]');
    if (!row) throw new Error('no row');
    await click(row);
    expect(toggles).toEqual([true]);
  });
});
