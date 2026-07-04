/**
 * Token price oracle for USD valuation (M4).
 * 
 * Provides:
 * - Token price fetching from CoinGecko / other sources
 * - Price caching (1-5 min TTL)
 * - Portfolio USD valuation
 * - Historical price tracking (optional)
 */

import { formatUnits } from 'viem';
import { Token } from '@/config/tokens';

/**
 * Cached price entry.
 */
interface PriceCache {
  tokenId: string;
  priceUSD: number;
  timestamp: number;
  ttl: number; // milliseconds
}

/**
 * Token price data.
 */
export interface TokenPrice {
  tokenId: string;
  symbol: string;
  priceUSD: number;
  change24h?: number; // percentage
  marketCap?: number;
  volume24h?: number;
  lastUpdated: number;
}

/**
 * Portfolio valuation.
 */
export interface PortfolioValuation {
  totalValueUSD: number;
  holdingsByToken: Array<{
    token: Token;
    balance: string;
    valueUSD: number;
    priceUSD: number;
  }>;
  lastUpdated: number;
}

// In-memory price cache (production would use Redis or persistent store)
const priceCache = new Map<string, PriceCache>();

// Default cache TTL: 5 minutes
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;

/**
 * Get current price for a token.
 * 
 * Uses cache when available; fetches from API if expired or missing.
 * 
 * @param token Token to get price for
 * @param forceRefresh Skip cache and fetch fresh price
 * @returns Token price in USD
 */
export async function getTokenPrice(
  token: Token,
  forceRefresh = false
): Promise<TokenPrice> {
  const cacheKey = `${token.id}_usd`;

  // Check cache if not forcing refresh
  if (!forceRefresh) {
    const cached = priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cached.ttl) {
      return {
        tokenId: token.id,
        symbol: token.symbol,
        priceUSD: cached.priceUSD,
        lastUpdated: cached.timestamp,
      };
    }
  }

  // Fetch fresh price
  const price = await fetchTokenPriceFromAPI(token);

  // Update cache
  priceCache.set(cacheKey, {
    tokenId: token.id,
    priceUSD: price,
    timestamp: Date.now(),
    ttl: DEFAULT_CACHE_TTL,
  });

  return {
    tokenId: token.id,
    symbol: token.symbol,
    priceUSD: price,
    lastUpdated: Date.now(),
  };
}

/**
 * Get prices for multiple tokens.
 * 
 * Batch fetches from API for efficiency.
 */
export async function getTokenPrices(
  tokens: Token[],
  forceRefresh = false
): Promise<TokenPrice[]> {
  const prices = await Promise.all(
    tokens.map(token => getTokenPrice(token, forceRefresh))
  );
  return prices;
}

/**
 * Fetch token price from external API (CoinGecko).
 * 
 * Implements fallback prices for testnet/shell tokens.
 */
async function fetchTokenPriceFromAPI(token: Token): Promise<number> {
  // Map token IDs to CoinGecko IDs
  const coinGeckoMap: Record<string, string> = {
    eth: 'ethereum',
    usdc: 'usd-coin',
    usdt: 'tether',
    dai: 'dai',
    arb: 'arbitrum',
    shell: 'shell', // May not exist on CoinGecko; use fallback
  };

  const tokenKey = token.id.toLowerCase();
  const cgId = coinGeckoMap[tokenKey];
  if (!cgId) {
    // Unknown token; use fallback price
    return getTokenFallbackPrice(tokenKey);
  }

  try {
    // Call CoinGecko API (free tier)
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }

    const data = await response.json();
    const price = data[cgId]?.usd;

    if (typeof price === 'number' && price > 0) {
      return price;
    }

    return getTokenFallbackPrice(tokenKey);
  } catch (error) {
    console.error(`Failed to fetch price for ${token.symbol}:`, error);
    return getTokenFallbackPrice(tokenKey);
  }
}

/**
 * Get fallback price for token.
 * 
 * Used when API is unavailable or token is not on public markets.
 */
function getTokenFallbackPrice(tokenId: string): number {
  const fallbackPrices: Record<string, number> = {
    eth: 3500,
    usdc: 1,
    usdt: 1,
    dai: 1,
    arb: 0.5,
    shell: 0.1, // Placeholder for Shell token
  };

  return fallbackPrices[tokenId.toLowerCase()] || 0;
}

/**
 * Calculate USD value for a token amount.
 * 
 * @param token Token
 * @param amount Amount (as wei string)
 * @param priceUSD Token price in USD
 * @returns USD value
 */
export function calculateUSDValue(
  token: Token,
  amount: string,
  priceUSD: number
): number {
  try {
    if (!Number.isInteger(token.decimals) || token.decimals < 0) {
      return 0;
    }
    if (!Number.isFinite(priceUSD) || priceUSD <= 0) {
      return 0;
    }

    const rawAmount = BigInt(amount);
    if (rawAmount < 0n) {
      return 0;
    }

    const humanAmount = Number(formatUnits(rawAmount, token.decimals));
    if (!Number.isFinite(humanAmount)) {
      return 0;
    }

    return humanAmount * priceUSD;
  } catch {
    return 0;
  }
}

/**
 * Valuate a portfolio of token balances.
 * 
 * @param holdings Array of token holdings with amounts
 * @param forceRefresh Refresh all prices from API
 * @returns Portfolio valuation summary
 */
export async function valuatePortfolio(
  holdings: Array<{ token: Token; balance: string }>,
  forceRefresh = false
): Promise<PortfolioValuation> {
  const tokens = holdings.map(h => h.token);
  const prices = await getTokenPrices(tokens, forceRefresh);

  const priceMap = new Map(prices.map(p => [p.tokenId, p.priceUSD]));

  let totalValueUSD = 0;
  const holdingsByToken = holdings.map(holding => {
    const priceUSD = priceMap.get(holding.token.id) || 0;
    const valueUSD = calculateUSDValue(holding.token, holding.balance, priceUSD);
    totalValueUSD += valueUSD;

    return {
      token: holding.token,
      balance: holding.balance,
      valueUSD,
      priceUSD,
    };
  });

  return {
    totalValueUSD,
    holdingsByToken,
    lastUpdated: Date.now(),
  };
}

/**
 * Calculate 24h portfolio change (requires historical data).
 * 
 * For M4, placeholder implementation.
 * Production would track price history.
 */
export function calculatePortfolioChange24h(
  _currentValuation: PortfolioValuation
): { change: number; changePercent: number } {
  // Placeholder: would require storing previous valuations
  return { change: 0, changePercent: 0 };
}

/**
 * Clear price cache.
 */
export function clearPriceCache(): void {
  priceCache.clear();
}

/**
 * Get cache statistics (for debugging).
 */
export function getPriceCacheStats(): {
  entries: number;
  oldestEntry?: number;
  newestEntry?: number;
} {
  if (priceCache.size === 0) {
    return { entries: 0 };
  }

  let oldest = Number.MAX_SAFE_INTEGER;
  let newest = 0;

  for (const entry of priceCache.values()) {
    if (entry.timestamp < oldest) oldest = entry.timestamp;
    if (entry.timestamp > newest) newest = entry.timestamp;
  }

  return {
    entries: priceCache.size,
    oldestEntry: oldest,
    newestEntry: newest,
  };
}

/**
 * Format USD value for display.
 */
export function formatUSD(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(2)}K`;
  }
  return `$${value.toFixed(2)}`;
}
