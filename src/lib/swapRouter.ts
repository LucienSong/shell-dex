/**
 * Shell DEX routing interface for swap quote retrieval and route selection.
 */

import type { SupportedChainId } from '@/config/chains';
import { type Token, getTokenAddress } from '@/config/tokens';
import type { Quote } from '@/hooks/useSwapState';
import {
  buildDeterministicFixtureRoutes,
  discoverMultiHopRoutes,
  type DiscoverRoutesOptions,
  type SwapRoute,
} from '@/lib/multiHopRouter';

const DEFAULT_QUOTE_TTL_MS = 30000;

export interface SwapQuote extends Quote {
  routes: SwapRoute[];
  selectedRouteId: string;
  selectedRoute: SwapRoute;
  swapContract?: string;
  callData?: string;
  estimatedGas?: string;
}

export interface SwapRouterConfig {
  routerApiUrl?: string;
  useFixtures?: boolean;
}

export interface GetQuoteOptions {
  preferredRouteId?: string;
  tradeType?: 'exactIn' | 'exactOut';
}

let routerConfig: SwapRouterConfig = {
  useFixtures: process.env.NODE_ENV !== 'production',
  routerApiUrl: process.env.NEXT_PUBLIC_SHELL_DEX_ROUTER_URL,
};

export function configureRouter(config: SwapRouterConfig) {
  routerConfig = { ...routerConfig, ...config };
}

export async function getQuote(
  inputToken: Token,
  outputToken: Token,
  inputAmount: string,
  chainId: SupportedChainId,
  options: GetQuoteOptions = {}
): Promise<SwapQuote> {
  if (!inputToken || !outputToken || !inputAmount) {
    throw new Error('Missing required parameters for quote');
  }

  if (inputToken.id === outputToken.id) {
    throw new Error('Cannot swap token for itself');
  }

  const inputAddr = getTokenAddress(inputToken.id, chainId);
  const outputAddr = getTokenAddress(outputToken.id, chainId);

  if (!inputAddr || !outputAddr) {
    throw new Error(
      `Token not available on chain ${chainId}: ${inputToken.symbol} or ${outputToken.symbol}`
    );
  }

  if (routerConfig.routerApiUrl) {
    try {
      const response = await fetch(`${routerConfig.routerApiUrl}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputToken: inputAddr,
          outputToken: outputAddr,
          amount: inputAmount,
          inputAmount: options.tradeType === 'exactIn' ? inputAmount : undefined,
          outputAmount: options.tradeType === 'exactOut' ? inputAmount : undefined,
          chainId,
          tradeType: options.tradeType ?? 'exactIn',
        }),
      });

      if (!response.ok) {
        throw new Error(`Router API error: ${response.statusText}`);
      }

      const data = await response.json();
      const routes = buildRoutesFromResponse(data, inputToken, outputToken, inputAmount, chainId, options);
      if (routes.length > 0) {
        return buildQuoteFromRoutes(routes, options.preferredRouteId, data.expireTime, options.tradeType);
      }
    } catch (error) {
      console.error('Shell DEX routing API error:', error);
      if (!routerConfig.useFixtures) {
        throw error;
      }
    }
  }

  if (routerConfig.useFixtures) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const routes = buildDeterministicFixtureRoutes(inputToken, outputToken, inputAmount, chainId, {
      swapContract: process.env.NEXT_PUBLIC_SHELL_DEX_ROUTER_ADDRESS,
      useFixtureRoutes: true,
      tradeType: options.tradeType,
    });
    return buildQuoteFromRoutes(routes, options.preferredRouteId, undefined, options.tradeType);
  }

  throw new Error('Router not configured: no API URL or fixtures enabled');
}

export function selectRouteQuote(quote: SwapQuote, routeId: string): SwapQuote {
  return buildQuoteFromRoutes(quote.routes, routeId, quote.expireTime, quote.tradeType);
}

export function canSwapPair(
  inputToken: Token,
  outputToken: Token,
  chainId: SupportedChainId
): boolean {
  if (inputToken.id === outputToken.id) return false;

  const inputAddr = getTokenAddress(inputToken.id, chainId);
  const outputAddr = getTokenAddress(outputToken.id, chainId);

  return !!inputAddr && !!outputAddr;
}

export function getSupportedPairs(_chainId: SupportedChainId) {
  return [];
}

function buildRoutesFromResponse(
  data: unknown,
  inputToken: Token,
  outputToken: Token,
  inputAmount: string,
  chainId: SupportedChainId,
  options: GetQuoteOptions = {}
): SwapRoute[] {
  const response = isRecord(data) ? data : {};
  const routeCandidates = extractRouteCandidates(response);
  const routeOptions: DiscoverRoutesOptions = {
    swapContract: firstString(response.swapContract, response.routerContract, response.router),
    callData: firstString(response.callData),
    estimatedGas: coerceAmount(response.estimatedGas ?? response.gasEstimate),
    outputAmount: coerceAmount(response.outputAmount ?? response.output),
    minReceived: coerceAmount(response.minReceived),
    fees: isRecord(response.fees)
      ? {
          total: coerceAmount(response.fees.total),
          percentage: coerceNumber(response.fees.percentage),
        }
      : undefined,
    priceImpact: coerceNumber(response.priceImpact),
    provider: firstString(response.provider, response.label),
    useFixtureRoutes: routerConfig.useFixtures,
    tradeType: options.tradeType,
  };

  return discoverMultiHopRoutes(routeCandidates, inputToken, outputToken, inputAmount, chainId, routeOptions);
}

function buildQuoteFromRoutes(
  routes: SwapRoute[],
  preferredRouteId?: string,
  expireTime?: unknown,
  tradeType: 'exactIn' | 'exactOut' = 'exactIn'
): SwapQuote {
  if (routes.length === 0) {
    throw new Error('No swap routes available');
  }

  const selectedRoute =
    routes.find(route => route.id === preferredRouteId) ??
    [...routes].sort((left, right) => left.rank - right.rank)[0];

  const resolvedExpireTime = resolveExpireTime(expireTime);

  return {
    inputAmount: selectedRoute.inputAmount,
    outputAmount: selectedRoute.expectedOutput,
    tradeType,
    route: selectedRoute.routePath,
    fees: {
      total: selectedRoute.estimatedTotalFees,
      percentage: selectedRoute.totalFeePercentage,
    },
    priceImpact: selectedRoute.priceImpact,
    minReceived: selectedRoute.minReceived,
    expireTime: resolvedExpireTime,
    estimatedGas: selectedRoute.estimatedTotalGas,
    swapContract: selectedRoute.swapContract,
    callData: selectedRoute.callData,
    routes,
    selectedRouteId: selectedRoute.id,
    selectedRoute,
  };
}

function extractRouteCandidates(response: Record<string, unknown>): unknown[] {
  const nestedKeys = ['routes', 'routeOptions', 'alternatives', 'quotes'];
  for (const key of nestedKeys) {
    const value = response[key];
    if (Array.isArray(value) && value.length > 0) {
      return value;
    }
  }

  if (isRecord(response.data)) {
    return extractRouteCandidates(response.data);
  }

  if (response.path || response.route || response.hops) {
    return [response];
  }

  return [];
}

function resolveExpireTime(expireTime: unknown): number {
  const parsed = typeof expireTime === 'number' ? expireTime : Number(expireTime);
  if (Number.isFinite(parsed) && parsed > Date.now()) {
    return parsed;
  }
  return Date.now() + DEFAULT_QUOTE_TTL_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function coerceAmount(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
