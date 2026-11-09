import { describe, expect, test } from 'bun:test';
import { isWithinQuietHours } from './quietHours';

const at = (hours: number, minutes: number) => new Date(2026, 0, 15, hours, minutes);

describe('isWithinQuietHours', () => {
  test('a same-day window includes its start minute and excludes its end minute', () => {
    expect(isWithinQuietHours(at(12, 59), '13:00', '15:00')).toBe(false);
    expect(isWithinQuietHours(at(13, 0), '13:00', '15:00')).toBe(true);
    expect(isWithinQuietHours(at(14, 59), '13:00', '15:00')).toBe(true);
    expect(isWithinQuietHours(at(15, 0), '13:00', '15:00')).toBe(false);
  });

  test('a window past midnight covers both sides of it', () => {
    expect(isWithinQuietHours(at(21, 59), '22:00', '08:00')).toBe(false);
    expect(isWithinQuietHours(at(22, 0), '22:00', '08:00')).toBe(true);
    expect(isWithinQuietHours(at(0, 0), '22:00', '08:00')).toBe(true);
    expect(isWithinQuietHours(at(7, 59), '22:00', '08:00')).toBe(true);
    expect(isWithinQuietHours(at(8, 0), '22:00', '08:00')).toBe(false);
    expect(isWithinQuietHours(at(12, 0), '22:00', '08:00')).toBe(false);
  });

  test('equal times make an empty window', () => {
    expect(isWithinQuietHours(at(9, 0), '09:00', '09:00')).toBe(false);
    expect(isWithinQuietHours(at(3, 0), '09:00', '09:00')).toBe(false);
  });
});
