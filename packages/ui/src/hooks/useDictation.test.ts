import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { DictationClient } from '@/lib/dictation/dictation-client';
import { DictationStreamSender } from '@/lib/dictation/dictation-stream-sender';
import * as audioSourceModule from '@/lib/dictation/use-dictation-audio-source';
import { soundSignals } from '@/lib/sounds/signals';
import { useConfigStore } from '@/stores/useConfigStore';
import { getDictationStartOptions, useDictation, type UseDictationResult } from './useDictation';

describe('getDictationStartOptions', () => {
  const original = {
    sttProvider: useConfigStore.getState().sttProvider,
    sttServerUrl: useConfigStore.getState().sttServerUrl,
    sttModel: useConfigStore.getState().sttModel,
    sttLanguage: useConfigStore.getState().sttLanguage,
    sttEndpointPath: useConfigStore.getState().sttEndpointPath,
  };

  afterEach(() => {
    useConfigStore.setState(original);
  });

  test('passes the custom stt endpoint path to the server', () => {
    useConfigStore.setState({
      sttProvider: 'openai-compatible',
      sttServerUrl: 'http://127.0.0.1:9/v1',
      sttModel: 'whisper-1',
      sttLanguage: 'en',
      sttEndpointPath: '/speech_to_text',
    });

    expect(getDictationStartOptions()).toEqual({
      provider: 'openai-compatible',
      language: 'en',
      openaiCompatible: {
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'whisper-1',
        endpointPath: '/speech_to_text',
      },
    });
  });

  test('leaves the path out when the setting is empty', () => {
    useConfigStore.setState({
      sttProvider: 'openai-compatible',
      sttServerUrl: 'http://127.0.0.1:9/v1',
      sttModel: 'whisper-1',
      sttLanguage: '',
      sttEndpointPath: '',
    });

    expect(getDictationStartOptions()).toEqual({
      provider: 'openai-compatible',
      openaiCompatible: {
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'whisper-1',
        endpointPath: undefined,
      },
    });
  });
});

// Other sounds are held back while a dictation records. Each hook instance holds on its own and
// must give the hold back on every way the recording ends, and only its own.
describe('useDictation sound hold', () => {
  const GLOBALS: string[] = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'IS_REACT_ACT_ENVIRONMENT'];

  type Behavior = { failStart: boolean; failStop: boolean; startOptions: audioSourceModule.DictationCaptureOptions[] };
  const behavior: Behavior = { failStart: false, failStop: false, startOptions: [] };
  type Probed = { current: UseDictationResult | null };
  const audio: audioSourceModule.DictationAudioSource = {
    start: async (options) => {
      behavior.startOptions.push(options ?? {});
      if (behavior.failStart) throw new Error('no microphone');
    },
    stop: async () => {
      if (behavior.failStop) throw new Error('teardown failed');
    },
    subscribeLevel: () => () => undefined,
  };

  let holds = 0;
  let spies: Array<{ mockRestore: () => void }> = [];
  const previous = new Map<string, PropertyDescriptor | undefined>();
  let roots: Root[] = [];

  beforeEach(() => {
    holds = 0;
    behavior.failStart = false;
    behavior.failStop = false;
    behavior.startOptions = [];
    const windowInstance = new Window({ url: 'http://localhost/' });
    for (const key of GLOBALS) previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    spies = [];
    const track = <T extends { mockRestore: () => void }>(spy: T): T => {
      spies.push(spy);
      return spy;
    };
    track(spyOn(audioSourceModule, 'useDictationAudioSource')).mockReturnValue(audio);
    track(spyOn(DictationClient.prototype, 'onPartial')).mockReturnValue(() => undefined);
    track(spyOn(DictationClient.prototype, 'subscribeConnectionStatus')).mockReturnValue(() => undefined);
    track(spyOn(DictationStreamSender.prototype, 'restartStream')).mockResolvedValue(undefined);
    track(spyOn(DictationStreamSender.prototype, 'getFinalSeq')).mockReturnValue(0);
    track(spyOn(DictationStreamSender.prototype, 'getDictationId')).mockReturnValue(null);
    track(spyOn(DictationStreamSender.prototype, 'hasSegments')).mockReturnValue(false);
    track(spyOn(DictationStreamSender.prototype, 'cancel')).mockImplementation(() => undefined);
    track(spyOn(DictationStreamSender.prototype, 'finish')).mockResolvedValue({ dictationId: 'dic_1', text: 'hello' });
    track(spyOn(soundSignals, 'dictationStarted')).mockResolvedValue(1234);
    track(spyOn(soundSignals, 'dictationStopped')).mockImplementation(() => undefined);
    track(spyOn(soundSignals, 'beginDictationCapture')).mockImplementation(() => {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
      };
    });
  });

  afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount());
    roots = [];
    for (const spy of spies) spy.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    previous.clear();
  });

  const mount = async () => {
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    const result: Probed = { current: null };
    const Probe = () => {
      result.current = useDictation();
      return null;
    };
    await act(async () => root.render(React.createElement(Probe)));
    const unmount = async () => {
      roots = roots.filter((entry) => entry !== root);
      await act(async () => root.unmount());
    };
    return { result, unmount };
  };

  const hook = (result: Probed): UseDictationResult => {
    if (!result.current) throw new Error('hook did not render');
    return result.current;
  };

  test('a recording holds the other sounds back, and hands the start sound to the capture as its discard window', async () => {
    const { result } = await mount();
    await act(async () => hook(result).startDictation());
    expect(holds).toBe(1);
    expect(hook(result).status).toBe('recording');
    expect(await behavior.startOptions[0]?.discardUntil).toBe(1234);
  });

  test('a start that fails releases the hold', async () => {
    behavior.failStart = true;
    const { result } = await mount();
    await act(async () => hook(result).startDictation());
    expect(hook(result).status).toBe('idle');
    expect(holds).toBe(0);
  });

  test('cancelling releases the hold', async () => {
    const { result } = await mount();
    await act(async () => hook(result).startDictation());
    expect(holds).toBe(1);
    await act(async () => hook(result).cancelDictation());
    expect(holds).toBe(0);
  });

  test('confirming releases the hold once the microphone is closed', async () => {
    const { result } = await mount();
    await act(async () => hook(result).startDictation());
    await act(async () => { await hook(result).confirmDictation(); });
    expect(holds).toBe(0);
    expect(hook(result).status).toBe('idle');
  });

  test('a confirm that fails releases the hold', async () => {
    const { result } = await mount();
    await act(async () => hook(result).startDictation());
    behavior.failStop = true;
    await act(async () => { await hook(result).confirmDictation(); });
    expect(holds).toBe(0);
  });

  test('unmounting while recording releases the hold', async () => {
    const { result, unmount } = await mount();
    await act(async () => hook(result).startDictation());
    expect(holds).toBe(1);
    await unmount();
    expect(holds).toBe(0);
  });

  test('an idle instance unmounting leaves the hold of another instance that records', async () => {
    const recording = await mount();
    const idle = await mount();
    await act(async () => hook(recording.result).startDictation());
    expect(holds).toBe(1);
    await idle.unmount();
    expect(holds).toBe(1);
    await recording.unmount();
    expect(holds).toBe(0);
  });

  test('two instances that record hold on their own, and each release leaves the other\'s hold', async () => {
    const first = await mount();
    const second = await mount();
    await act(async () => hook(first.result).startDictation());
    await act(async () => hook(second.result).startDictation());
    expect(holds).toBe(2);
    await act(async () => hook(first.result).cancelDictation());
    expect(holds).toBe(1);
    await second.unmount();
    expect(holds).toBe(0);
  });
});
