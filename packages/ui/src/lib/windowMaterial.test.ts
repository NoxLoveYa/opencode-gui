import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { applyEmbeddedWindowMaterial } from './windowMaterial';

describe('applyEmbeddedWindowMaterial', () => {
  const previousDocument = globalThis.document;
  beforeEach(() => {
    const window = new Window();
    Object.assign(globalThis, { document: window.document });
  });
  afterEach(() => {
    Object.assign(globalThis, { document: previousDocument });
  });

  test('sets the dataset and opacity for mica', () => {
    applyEmbeddedWindowMaterial('mica', 50);
    expect(document.documentElement.dataset.windowMaterial).toBe('mica');
    expect(document.documentElement.style.getPropertyValue('--oc-window-material-opacity')).toBe('0.5');
  });

  test('sets the dataset and opacity for acrylic', () => {
    applyEmbeddedWindowMaterial('acrylic', 5);
    expect(document.documentElement.dataset.windowMaterial).toBe('acrylic');
    expect(document.documentElement.style.getPropertyValue('--oc-window-material-opacity')).toBe('0.05');
  });

  test('removes both when material is off', () => {
    document.documentElement.dataset.windowMaterial = 'mica';
    document.documentElement.style.setProperty('--oc-window-material-opacity', '0.5');
    applyEmbeddedWindowMaterial('off', 75);
    expect(document.documentElement.dataset.windowMaterial).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--oc-window-material-opacity')).toBe('');
  });
});
