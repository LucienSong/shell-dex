/**
 * Error handling utilities for swap operations in shell-dex M2.
 * 
 * Handles:
 * - Route not found errors
 * - Network failures
 * - Token validation errors
 * - Quote expiration
 * - Network switch detection
 */

import type { Token } from '@/config/tokens';
import type { SupportedChainId } from '@/config/chains';

export class SwapError extends Error {
  constructor(
    message: string,
    public code: string,
    public recoverable: boolean = true
  ) {
    super(message);
    this.name = 'SwapError';
  }
}

export interface SwapErrorContext {
  inputToken?: Token;
  outputToken?: Token;
  chainId?: SupportedChainId;
  originalError?: Error;
}

/**
 * Validate token pair for swap.
 */
export function validateTokenPair(input: Token, output: Token): void {
  if (!input || !output) {
    throw new SwapError('Input and output tokens required', 'MISSING_TOKENS', false);
  }

  if (input.id === output.id) {
    throw new SwapError(
      'Cannot swap token for itself',
      'SAME_TOKEN',
      false
    );
  }
}

/**
 * Validate input amount.
 */
export function validateInputAmount(amount: string, decimals: number): void {
  if (!amount || amount === '0') {
    throw new SwapError('Enter an amount to swap', 'ZERO_AMOUNT', true);
  }

  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) {
    throw new SwapError('Invalid amount entered', 'INVALID_AMOUNT', true);
  }

  // Check decimal places
  const parts = amount.split('.');
  if (parts[1] && parts[1].length > decimals) {
    throw new SwapError(
      `Maximum ${decimals} decimal places allowed`,
      'TOO_MANY_DECIMALS',
      true
    );
  }
}

/**
 * Handle routing errors with user-friendly messages.
 */
export function handleRoutingError(error: Error | unknown): SwapError {
  if (error instanceof SwapError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  // Network errors
  if (message.includes('NetworkError') || message.includes('Failed to fetch')) {
    return new SwapError(
      'Network connection failed. Please check your internet and try again.',
      'NETWORK_ERROR',
      true
    );
  }

  // Route not found
  if (message.includes('route') || message.includes('No route')) {
    return new SwapError(
      'No trading route available for this pair on the selected network.',
      'NO_ROUTE_FOUND',
      true
    );
  }

  // Slippage
  if (message.includes('slippage')) {
    return new SwapError(
      'Price slippage exceeded. Try refreshing the quote or increasing slippage tolerance.',
      'SLIPPAGE_ERROR',
      true
    );
  }

  // Insufficient liquidity
  if (
    message.includes('liquidity') ||
    message.includes('insufficient')
  ) {
    return new SwapError(
      'Insufficient liquidity for this swap. Try a smaller amount.',
      'INSUFFICIENT_LIQUIDITY',
      true
    );
  }

  // Generic fallback
  return new SwapError(
    message || 'Failed to fetch swap quote. Please try again.',
    'QUOTE_ERROR',
    true
  );
}

/**
 * Detect if error is due to network switch.
 */
export function isNetworkSwitchError(error: Error | unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('chain') ||
    message.includes('network') ||
    message.includes('chainId') ||
    message.includes('switched')
  );
}

/**
 * Format error message for display.
 */
export function getErrorDisplay(
  error: SwapError,
  context?: SwapErrorContext
): string {
  if (!error.recoverable) {
    return `⚠️ ${error.message}`;
  }

  return `Error: ${error.message}`;
}

/**
 * Get recovery suggestion for error.
 */
export function getRecoverySuggestion(error: SwapError): string | null {
  switch (error.code) {
    case 'NETWORK_ERROR':
      return 'Check your internet connection and refresh the page.';
    case 'NO_ROUTE_FOUND':
      return 'Try a different token pair or smaller amount.';
    case 'SLIPPAGE_ERROR':
      return 'Refresh the quote or check slippage settings (M3+).';
    case 'INSUFFICIENT_LIQUIDITY':
      return 'Try swapping a smaller amount.';
    case 'QUOTE_ERROR':
      return 'Refresh the quote and try again.';
    default:
      return null;
  }
}
