import { describe, expect, it } from 'vitest';
import {
  getTokenAddress,
  isValidAddress,
  normalizeAddress,
} from '../src/config/tokens';

describe('token address validation', () => {
  it('accepts mixed-case 20-byte addresses', () => {
    const address = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5F86';
    expect(isValidAddress(address)).toBe(true);
    expect(normalizeAddress(address)).toBe(address.toLowerCase());
  });

  it('normalizes configured token addresses to lowercase', () => {
    expect(getTokenAddress('usdc', 42161)).toBe('0xff970a61a04b1ca14834a43f5de4533ebddb5f86');
  });

  it('rejects non-20-byte addresses', () => {
    expect(isValidAddress('0x1234')).toBe(false);
  });
});
