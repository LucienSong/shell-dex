import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateUSDValue,
  clearPriceCache,
  formatUSD,
  valuatePortfolio,
} from '../src/lib/priceOracle';
import type { Token } from '../src/config/tokens';

const ethToken: Token = {
  id: 'eth',
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  addresses: { 42161: '0x0000000000000000000000000000000000000000' },
  logoUrl: '/tokens/eth.svg',
};

const usdcToken: Token = {
  id: 'usdc',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  addresses: { 42161: '0xff970a61a04b1ca14834a43f5de4533ebddb5f86' },
  logoUrl: '/tokens/usdc.svg',
};

afterEach(() => {
  clearPriceCache();
  vi.unstubAllGlobals();
});

describe('calculateUSDValue', () => {
  it('converts 18-decimal base units before applying price', () => {
    expect(calculateUSDValue(ethToken, '1000000000000000000', 3500)).toBe(3500);
    expect(calculateUSDValue(ethToken, '1500000000000000000', 2000)).toBe(3000);
  });

  it('converts 6-decimal base units before applying price', () => {
    expect(calculateUSDValue(usdcToken, '1234567', 1)).toBeCloseTo(1.234567);
    expect(calculateUSDValue(usdcToken, '2500000', 0.99)).toBeCloseTo(2.475);
  });

  it('returns zero for malformed or negative base-unit amounts', () => {
    expect(calculateUSDValue(usdcToken, '1.5', 1)).toBe(0);
    expect(calculateUSDValue(usdcToken, '1e6', 1)).toBe(0);
    expect(calculateUSDValue(usdcToken, '-1', 1)).toBe(0);
  });

  it('returns zero for invalid decimals or prices', () => {
    expect(calculateUSDValue({ ...usdcToken, decimals: -1 }, '1000000', 1)).toBe(0);
    expect(calculateUSDValue({ ...usdcToken, decimals: 1.5 }, '1000000', 1)).toBe(0);
    expect(calculateUSDValue(usdcToken, '1000000', 0)).toBe(0);
    expect(calculateUSDValue(usdcToken, '1000000', Number.NaN)).toBe(0);
  });
});

describe('valuatePortfolio', () => {
  it('sums token values using base-unit balances', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('ethereum')) {
        return jsonResponse({ ethereum: { usd: 3500 } });
      }
      if (url.includes('usd-coin')) {
        return jsonResponse({ 'usd-coin': { usd: 1 } });
      }
      return jsonResponse({});
    }));

    const portfolio = await valuatePortfolio([
      { token: ethToken, balance: '1000000000000000000' },
      { token: usdcToken, balance: '2500000' },
    ]);

    expect(portfolio.totalValueUSD).toBeCloseTo(3502.5);
    expect(portfolio.holdingsByToken.find((holding) => holding.token.id === 'eth')?.valueUSD)
      .toBeCloseTo(3500);
    expect(portfolio.holdingsByToken.find((holding) => holding.token.id === 'usdc')?.valueUSD)
      .toBeCloseTo(2.5);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('formatUSD', () => {
  it('formats compact USD values', () => {
    expect(formatUSD(12.3)).toBe('$12.30');
    expect(formatUSD(1234)).toBe('$1.23K');
    expect(formatUSD(1_234_567)).toBe('$1.23M');
  });
});
