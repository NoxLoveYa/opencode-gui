import { Annotation, Transaction, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * Marks an edit the app made for the user (a restored draft, a mention
 * inserted from a picker). It reads as typing to CodeMirror but is no key
 * press, so it makes no sound.
 */
export const silentEdit = Annotation.define<true>();

type SoundFeedbackSignals = {
  typed: () => void;
  erased: () => void;
  /** False while no keystroke could make a sound, so an update costs one call. */
  typingActive: () => boolean;
};

/**
 * Reports key presses to the sound system: typing, including IME composition
 * and the newline of Shift+Enter, and erasing. Paste, drop, cut, undo, redo
 * and picker completions are not key presses and report nothing. At most one call per update.
 *
 * It touches no React state and no store, so a keystroke renders exactly what
 * it rendered before.
 */
export const composerSoundFeedback = (signals: SoundFeedbackSignals): Extension => (
  EditorView.updateListener.of((update) => {
    if (!update.docChanged || !signals.typingActive()) return;
    let typed = false;
    let erased = false;
    for (const transaction of update.transactions) {
      if (!transaction.docChanged || transaction.annotation(silentEdit)) continue;
      // A newline from Enter is exactly `input`; paste, drop and completion are `input.*` subtypes.
      if (transaction.isUserEvent('input.type') || transaction.annotation(Transaction.userEvent) === 'input') typed = true;
      else if (
        transaction.isUserEvent('delete')
        && !transaction.isUserEvent('delete.cut')
        && !transaction.isUserEvent('delete.dragstart')
      ) erased = true;
    }
    if (typed) signals.typed();
    else if (erased) signals.erased();
  })
);
