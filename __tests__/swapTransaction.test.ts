/**
 * Tests for DEX-CRIT-1: Slippage protection correctness.
 *
 * Verifies:
 * 1. calculateMinimumOutput uses correct basis-point math.
 * 2. encodeSlippageIntoCallData embeds minOutput into calldata that can be
 *    decoded and verified on-chain (router ABI round-trip).
 */

import { describe, it, expect } from 'vitest';
import { decodeFunctionData, encodeFunctionData, zeroAddress } from 'viem';
import {
  buildSwapTransaction,
  calculateMinimumOutput,
  encodeSlippageIntoCallData,
  SHELL_DEX_ROUTER_ABI,
} from '../src/lib/swapTransaction';
import type { SwapQuote } from '../src/lib/swapRouter';

// ── calculateMinimumOutput ────────────────────────────────────────────────────

describe('calculateMinimumOutput', () => {
  it('returns 995 for expectedOutput=1000 and slippageBps=50 (0.5 %)', () => {
    const result = calculateMinimumOutput(1000n, 50);
    expect(result).toBe(995n);
  });

  it('returns 990 for expectedOutput=1000 and slippageBps=100 (1 %)', () => {
    expect(calculateMinimumOutput(1000n, 100)).toBe(990n);
  });

  it('returns 9999 for expectedOutput=10000 and slippageBps=1 (0.01 %)', () => {
    expect(calculateMinimumOutput(10000n, 1)).toBe(9999n);
  });

  it('works correctly with large BigInt values', () => {
    // 1 ETH in wei = 1_000_000_000_000_000_000n, 0.5 % slippage
    const oneEth = 1_000_000_000_000_000_000n;
    const min = calculateMinimumOutput(oneEth, 50);
    expect(min).toBe(995_000_000_000_000_000n);
  });

  it('returns the expected output unchanged for slippageBps = 0', () => {
    expect(calculateMinimumOutput(1000n, 0)).toBe(1000n);
  });

  it('throws for slippageBps = 5001 (above maximum)', () => {
    expect(() => calculateMinimumOutput(1000n, 5001)).toThrow();
  });

  it('throws for non-integer slippageBps', () => {
    expect(() => calculateMinimumOutput(1000n, 0.5 as unknown as number)).toThrow();
  });
});

// ── encodeSlippageIntoCallData ────────────────────────────────────────────────

describe('encodeSlippageIntoCallData', () => {
  const tokenIn   = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  const tokenOut  = '0x2222222222222222222222222222222222222222' as `0x${string}`;
  const recipient = '0x3333333333333333333333333333333333333333' as `0x${string}`;
  const amountIn  = 500n;
  const deadline  = 9999999999n;

  function makeCallData(amountOutMinimum: bigint): `0x${string}` {
    return encodeFunctionData({
      abi: SHELL_DEX_ROUTER_ABI,
      functionName: 'swap',
      args: [tokenIn, tokenOut, amountIn, amountOutMinimum, recipient, deadline],
    });
  }

  it('replaces amountOutMinimum with the provided minOutput (995 for 0.5 % slippage on 1000)', () => {
    const originalCallData = makeCallData(0n); // placeholder minOutput
    const updatedCallData  = encodeSlippageIntoCallData(originalCallData, '995');

    const decoded = decodeFunctionData({
      abi: SHELL_DEX_ROUTER_ABI,
      data: updatedCallData as `0x${string}`,
    });

    // args: [tokenIn, tokenOut, amountIn, amountOutMinimum, recipient, deadline]
    expect(decoded.args[3]).toBe(995n);
  });

  it('preserves all other swap parameters when re-encoding', () => {
    const originalCallData = makeCallData(0n);
    const updatedCallData  = encodeSlippageIntoCallData(originalCallData, '500');

    const decoded = decodeFunctionData({
      abi: SHELL_DEX_ROUTER_ABI,
      data: updatedCallData as `0x${string}`,
    });

    expect((decoded.args[0] as string).toLowerCase()).toBe(tokenIn.toLowerCase());
    expect((decoded.args[1] as string).toLowerCase()).toBe(tokenOut.toLowerCase());
    expect(decoded.args[2]).toBe(amountIn);
    expect(decoded.args[3]).toBe(500n);
    expect((decoded.args[4] as string).toLowerCase()).toBe(recipient.toLowerCase());
    expect(decoded.args[5]).toBe(deadline);
  });

  it('round-trip: calculateMinimumOutput → encodeSlippageIntoCallData → decoded minOutput matches', () => {
    const expectedOutput = 1000n;
    const slippageBps    = 50; // 0.5 %
    const minOutput      = calculateMinimumOutput(expectedOutput, slippageBps);

    expect(minOutput).toBe(995n);

    const originalCallData = makeCallData(0n);
    const updatedCallData  = encodeSlippageIntoCallData(originalCallData, minOutput.toString());

    const decoded = decodeFunctionData({
      abi: SHELL_DEX_ROUTER_ABI,
      data: updatedCallData as `0x${string}`,
    });

    expect(decoded.args[3]).toBe(995n);
  });

  it('throws when calldata does not match the Shell DEX router ABI', () => {
    const invalidCallData = '0xdeadbeef';
    expect(() => encodeSlippageIntoCallData(invalidCallData, '995')).toThrow();
  });

  it('handles zero address tokens gracefully', () => {
    const callData = encodeFunctionData({
      abi: SHELL_DEX_ROUTER_ABI,
      functionName: 'swap',
      args: [zeroAddress, zeroAddress, 100n, 0n, zeroAddress, deadline],
    });
    const updated = encodeSlippageIntoCallData(callData, '99');
    const decoded = decodeFunctionData({ abi: SHELL_DEX_ROUTER_ABI, data: updated as `0x${string}` });
    expect(decoded.args[3]).toBe(99n);
  });
});

// ── buildSwapTransaction amount parsing ─────────────────────────────────────

describe('buildSwapTransaction amount parsing', () => {
  const tokenIn   = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  const tokenOut  = '0x2222222222222222222222222222222222222222' as `0x${string}`;
  const recipient = '0x3333333333333333333333333333333333333333' as `0x${string}`;
  const router    = '0x4444444444444444444444444444444444444444' as `0x${string}`;
  const deadline  = 9999999999n;

  function makeQuote(outputAmount = '1000'): SwapQuote {
    return {
      inputAmount: '1',
      outputAmount,
      tradeType: 'exactIn',
      route: [tokenIn, tokenOut],
      fees: { total: '0', percentage: 0 },
      priceImpact: 0,
      minReceived: '995',
      expireTime: Date.now() + 30_000,
      estimatedGas: '210000',
      swapContract: router,
      callData: encodeFunctionData({
        abi: SHELL_DEX_ROUTER_ABI,
        functionName: 'swap',
        args: [tokenIn, tokenOut, 500n, 0n, recipient, deadline],
      }),
      routes: [],
      selectedRouteId: 'direct',
      selectedRoute: {
        id: 'direct',
        rank: 1,
        routePath: [tokenIn, tokenOut],
        inputAmount: '1',
        expectedOutput: outputAmount,
        estimatedTotalFees: '0',
        totalFeePercentage: 0,
        priceImpact: 0,
        minReceived: '995',
        estimatedTotalGas: '210000',
        swapContract: router,
        callData: '0x',
        hops: [],
      },
    } as unknown as SwapQuote;
  }

  it('rejects invalid native input amounts before building a transaction', () => {
    expect(() => buildSwapTransaction({
      quote: makeQuote(),
      slippageTolerance: 0.005,
      userAddress: recipient,
      inputAmount: '-1',
      inputTokenDecimals: 18,
      outputTokenDecimals: 18,
      isNativeInput: true,
    })).toThrow('Input amount must be a positive decimal value');

    expect(() => buildSwapTransaction({
      quote: makeQuote(),
      slippageTolerance: 0.005,
      userAddress: recipient,
      inputAmount: '0',
      inputTokenDecimals: 18,
      outputTokenDecimals: 18,
      isNativeInput: true,
    })).toThrow('Input amount must be greater than zero');
  });

  it('rejects quote outputs that exceed token decimal precision', () => {
    expect(() => buildSwapTransaction({
      quote: makeQuote('0.0000001'),
      slippageTolerance: 0.005,
      userAddress: recipient,
      inputAmount: '1',
      inputTokenDecimals: 18,
      outputTokenDecimals: 6,
      isNativeInput: false,
    })).toThrow('Quote output amount is invalid for token decimals');
  });
});
