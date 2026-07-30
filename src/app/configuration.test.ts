import { describe, expect, it } from 'vitest';
import { toInitializationMode } from './configuration';

describe('toInitializationMode', () => {
  it.each([
    [undefined, 'manual'],
    ['manual', 'manual'],
    ['automatic', 'automatic'],
    ['unknown', 'manual'],
    [true, 'manual'],
  ] as const)('%j は %s', (value, expected) => {
    expect(toInitializationMode(value)).toBe(expected);
  });
});
