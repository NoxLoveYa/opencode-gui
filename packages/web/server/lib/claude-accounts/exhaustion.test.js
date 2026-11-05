import { describe, expect, it } from 'vitest';

import { RECENT_SWITCH_MS, createExhaustionRegistry } from './exhaustion.js';

const create = () => {
  let clock = 1_000_000;
  const registry = createExhaustionRegistry({ now: () => clock });
  return { registry, advance: (ms) => { clock += ms; }, now: () => clock };
};

describe('accounts that are out', () => {
  it('stay out until the time they were given, then are back', () => {
    const { registry, advance, now } = create();
    registry.markExhausted('crd_a', now() + 60_000);

    expect(registry.isExhausted('crd_a')).toBe(true);
    expect(registry.isExhausted('crd_b')).toBe(false);
    advance(60_001);
    expect(registry.isExhausted('crd_a')).toBe(false);
  });

  it('ignore a time that is not a time', () => {
    const { registry } = create();
    registry.markExhausted('crd_a', undefined);
    registry.markExhausted('crd_b', Number.NaN);

    expect(registry.isExhausted('crd_a')).toBe(false);
    expect(registry.isExhausted('crd_b')).toBe(false);
  });

  it('are back when something switches to them: they cannot be out and live', () => {
    const { registry, now } = create();
    registry.markExhausted('crd_a', now() + 60_000);

    registry.noteSwitch('crd_a');

    expect(registry.isExhausted('crd_a')).toBe(false);
  });
});

describe('the account just switched to', () => {
  it('is recent for a minute only', () => {
    const { registry, advance, now } = create();
    registry.noteSwitch('crd_a');

    expect(registry.recentSwitchAt('crd_a')).toBe(now());
    expect(registry.recentSwitchAt('crd_b')).toBeUndefined();
    advance(RECENT_SWITCH_MS);
    expect(registry.recentSwitchAt('crd_a')).toBe(now() - RECENT_SWITCH_MS);
    advance(1);
    expect(registry.recentSwitchAt('crd_a')).toBeUndefined();
  });

  it('is forgotten with the account', () => {
    const { registry, now } = create();
    registry.noteSwitch('crd_a');
    registry.markExhausted('crd_b', now() + 60_000);

    registry.forget('crd_a');
    registry.forget('crd_b');

    expect(registry.recentSwitchAt('crd_a')).toBeUndefined();
    expect(registry.isExhausted('crd_b')).toBe(false);
  });
});
