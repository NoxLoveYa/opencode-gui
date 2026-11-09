import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

const hydrateFrom = async (version: number, fields: Record<string, unknown>): Promise<void> => {
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version, state: { ...useUIStore.getInitialState(), ...fields } }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
};

describe('window material migration', () => {
  test('repairs invalid stored values on a store from before the fields existed', async () => {
    await hydrateFrom(26, { desktopWindowMaterial: 'glass', desktopWindowMaterialOpacity: 'wide' });
    expect(useUIStore.getState().desktopWindowMaterial).toBe('off');
    expect(useUIStore.getState().desktopWindowMaterialOpacity).toBe(75);
  });

  test('keeps valid values through the migration', async () => {
    await hydrateFrom(26, { desktopWindowMaterial: 'mica', desktopWindowMaterialOpacity: 60 });
    expect(useUIStore.getState().desktopWindowMaterial).toBe('mica');
    expect(useUIStore.getState().desktopWindowMaterialOpacity).toBe(60);
  });

  test('leaves a current store untouched', async () => {
    await hydrateFrom(28, { desktopWindowMaterial: 'mica', desktopWindowMaterialOpacity: 60 });
    expect(useUIStore.getState().desktopWindowMaterial).toBe('mica');
    expect(useUIStore.getState().desktopWindowMaterialOpacity).toBe(60);
  });
});
