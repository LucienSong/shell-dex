import { describe, expect, it } from 'vitest';
import { getToken } from '../src/config/tokens';
import { getBridgeQuote, normalizeBridgeAmount } from '../src/lib/bridgeRouter';

describe('normalizeBridgeAmount', () => {
  it('normalizes valid decimal input to token precision', () => {
    expect(normalizeBridgeAmount(' 1.230000 ', 6, 'USDC')).toBe('1.23');
    expect(normalizeBridgeAmount('0.000001', 6, 'USDC')).toBe('0.000001');
  });

  it('rejects zero, scientific notation, hex, and over-precision values', () => {
    expect(() => normalizeBridgeAmount('0', 6, 'USDC')).toThrow('Enter a valid USDC amount.');
    expect(() => normalizeBridgeAmount('1e3', 6, 'USDC')).toThrow('Enter a valid USDC amount.');
    expect(() => normalizeBridgeAmount('0x1', 6, 'USDC')).toThrow('Enter a valid USDC amount.');
    expect(() => normalizeBridgeAmount('0.0000001', 6, 'USDC')).toThrow('Enter a valid USDC amount.');
  });
});

describe('getBridgeQuote amount validation', () => {
  it('uses normalized decimal amounts in deterministic bridge quotes', async () => {
    const token = getToken('usdc');
    if (!token) throw new Error('USDC fixture token missing');

    const quote = await getBridgeQuote(token, '1.230000', 42161, 10);

    expect(quote.inputAmount).toBe('1.23');
    expect(quote.estimatedOutputAmount).not.toBe('0');
  });

  it('rejects non-decimal bridge amount input before quote construction', async () => {
    const token = getToken('usdc');
    if (!token) throw new Error('USDC fixture token missing');

    await expect(getBridgeQuote(token, '1e3', 42161, 10)).rejects.toThrow('Enter a valid USDC amount.');
  });
});
