import { afterEach, describe, it, expect, vi } from 'vitest';
import { localToIso, localValue, range } from './api';
afterEach(() => vi.unstubAllGlobals());
describe('clinic calendar IANA conversion', () => {
  it('uses the configured clinic zone instead of the browser zone', () => {
    vi.stubGlobal('document', { documentElement: { dataset: { clinicTimeZone: 'Asia/Tokyo' } } });
    expect(localToIso('2026-11-06T09:00')).toBe('2026-11-06T00:00:00.000Z');
    expect(localValue('2026-11-06T00:00:00Z')).toBe('2026-11-06T09:00');
  });
  it('uses historical Kazakhstan offsets and calendar-day boundaries', () => {
    vi.stubGlobal('document', { documentElement: { dataset: { clinicTimeZone: 'Asia/Almaty' } } });
    expect(localToIso('2024-02-01T09:00')).toBe('2024-02-01T03:00:00.000Z');
    expect(localToIso('2026-11-06T09:00')).toBe('2026-11-06T04:00:00.000Z');
    expect(range('2026-11-06')).toEqual({
      from: '2026-11-05T19:00:00.000Z',
      to: '2026-11-06T19:00:00.000Z',
    });
  });
  it('rejects malformed local calendar input', () => {
    expect(() => localToIso('invalid')).toThrow();
  });
});
