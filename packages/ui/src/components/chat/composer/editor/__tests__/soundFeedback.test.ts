import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { composerSoundFeedback, silentEdit } from '../soundFeedback';

describe('composer sound feedback', () => {
  let browser: Window;
  let view: EditorView;
  let descriptors: Map<string, PropertyDescriptor | undefined>;
  let typed: number;
  let erased: number;
  let active: boolean;

  beforeEach(() => {
    browser = new Window();
    const globals = {
      window: browser, document: browser.document, navigator: browser.navigator,
      HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
      MutationObserver: browser.MutationObserver,
      requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
      cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
      getComputedStyle: browser.getComputedStyle.bind(browser),
    };
    descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    typed = 0;
    erased = 0;
    active = true;
    view = new EditorView({
      state: EditorState.create({
        doc: 'hello',
        extensions: [composerSoundFeedback({
          typed: () => { typed += 1; },
          erased: () => { erased += 1; },
          typingActive: () => active,
        })],
      }),
      parent: document.body,
    });
  });

  afterEach(() => {
    view.destroy();
    browser.close();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  const insert = (userEvent?: string, annotations?: TransactionSpec['annotations']) => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'x' }, userEvent, annotations });
  };
  const remove = (userEvent?: string) => {
    view.dispatch({ changes: { from: 0, to: 1 }, userEvent });
  };

  test('typing, including IME composition, reports typed', () => {
    insert('input.type');
    insert('input.type.compose');
    expect(typed).toBe(2);
    expect(erased).toBe(0);
  });

  test('a newline from Enter or Shift+Enter reports typed', () => {
    insert('input');
    expect(typed).toBe(1);
    expect(erased).toBe(0);
  });

  test('deleting reports erased', () => {
    for (const userEvent of ['delete.backward', 'delete.forward', 'delete.selection', 'delete.line']) remove(userEvent);
    expect(erased).toBe(4);
    expect(typed).toBe(0);
  });

  test('edits that are not key presses report nothing', () => {
    for (const userEvent of ['input.paste', 'input.drop', 'input.complete', 'undo', 'redo', undefined]) insert(userEvent);
    for (const userEvent of ['delete.cut', 'delete.dragstart']) remove(userEvent);
    expect(typed).toBe(0);
    expect(erased).toBe(0);
  });

  test('an edit marked silent reports nothing even when it reads as typing', () => {
    insert('input.type', silentEdit.of(true));
    expect(typed).toBe(0);
  });

  test('a caret move reports nothing', () => {
    view.dispatch({ selection: { anchor: 2 } });
    expect(typed + erased).toBe(0);
  });

  test('makes at most one call per update', () => {
    // Two transactions applied as one update, each built on the state the one before left.
    const dispatchTogether = (first: TransactionSpec, second: TransactionSpec) => {
      const firstTransaction = view.state.update(first);
      view.dispatch([firstTransaction, firstTransaction.state.update(second)]);
    };
    dispatchTogether(
      { changes: { from: 0, insert: 'a' }, userEvent: 'input.type' },
      { changes: { from: 1, insert: 'b' }, userEvent: 'input.type' },
    );
    expect(typed).toBe(1);
    dispatchTogether(
      { changes: { from: 0, to: 1 }, userEvent: 'delete.backward' },
      { changes: { from: 0, insert: 'c' }, userEvent: 'input.type' },
    );
    expect(typed).toBe(2);
    expect(erased).toBe(0);
  });

  test('does nothing while no keystroke could make a sound', () => {
    active = false;
    insert('input.type');
    remove('delete.backward');
    expect(typed + erased).toBe(0);
  });
});
