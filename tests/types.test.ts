import { describe, expect, it } from 'vitest';

import { SafetyError, type SafetyReason } from '../src/types.js';

describe('SafetyError', () => {
  it('is a real Error subclass carrying a machine-readable reason', () => {
    const reason: SafetyReason = 'root-is-home';
    const err = new SafetyError(reason, 'refusing to scan the home directory');

    // Task 12 maps a caught SafetyError to exit code 3 via instanceof; a broken
    // prototype chain would make that check silently fall through to a generic failure.
    expect(err).toBeInstanceOf(SafetyError);
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('root-is-home');
    expect(err.name).toBe('SafetyError');
    expect(err.message).toBe('refusing to scan the home directory');
  });
});
