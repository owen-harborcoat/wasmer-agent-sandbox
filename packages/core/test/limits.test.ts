import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, resolveLimits } from '../src/index.js';

describe('resolveLimits', () => {
  it('fills unspecified limits from the defaults', () => {
    expect(resolveLimits({ timeoutMs: 5 })).toEqual({ ...DEFAULT_LIMITS, timeoutMs: 5 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (value) => {
    expect(() => resolveLimits({ timeoutMs: value })).toThrow(RangeError);
    expect(() => resolveLimits({ outputBytes: value })).toThrow(RangeError);
  });
});
