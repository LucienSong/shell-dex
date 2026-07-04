/**
 * Swap transaction building for M3 execution.
 *
 * Constructs viem transaction requests from routing quotes,
 * applies slippage adjustments, and validates output amounts.
 */

import {
  type Abi,
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  parseUnits,
} from 'viem';
import { SwapQuote } from './swapRouter';

/**
 * Shell DEX router ABI – swap function that the on-chain router enforces.
 *
 * The router validates that the actual output >= amountOutMinimum and reverts
 * if it does not, making this the key slippage-protection hook.
 */
export const SHELL_DEX_ROUTER_ABI = [
  {
    name: 'swap',
    type: 'function',
    inputs: [
      { name: 'tokenIn',           type: 'address' },
      { name: 'tokenOut',          type: 'address' },
      { name: 'amountIn',          type: 'uint256' },
      { name: 'amountOutMinimum',  type: 'uint256' },
      { name: 'recipient',         type: 'address' },
      { name: 'deadline',          type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
    stateMutability: 'payable',
  },
] as const satisfies Abi;

export interface SwapTransactionParams {
  quote: SwapQuote;
  slippageTolerance: number; // 0–1 as a decimal (e.g. 0.005 = 0.5 %).  Converted to BPS internally.
  userAddress: Address;
  swapContract?: Address;
  inputAmount: string;
  inputTokenDecimals: number;
  outputTokenDecimals: number;
  isNativeInput: boolean;
}

export interface SwapTransaction {
  to: Address;
  from: Address;
  data: Hex;
  value: bigint;
  estimatedGas?: bigint;
  minOutput: bigint;
  expectedOutput: bigint;
}

/**
 * Apply slippage tolerance to minimum output amount.
 *
 * @param outputAmount The expected output amount (in token base units, as BigInt)
 * @param slippageBps  Slippage in basis points (0 = 0 %, 50 = 0.5 %, 5000 = 50 %).
 *                     Accepted range: 0–5000.
 * @returns Minimum acceptable output after slippage
 *
 * Formula: minOutput = outputAmount × (10000 − slippageBps) / 10000
 *
 * Previous implementation erroneously used (slippageTolerance × 100) as the
 * numerator instead of the correct basis-point value, producing protection that
 * was 100× weaker than intended (DEX-CRIT-1).
 */
export function calculateMinimumOutput(
  outputAmount: bigint,
  slippageBps: number
): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) {
    throw new Error('slippageBps must be an integer between 0 and 5000 (0 %–50 %)');
  }

  const minimumOutput = (outputAmount * BigInt(10000 - slippageBps)) / 10000n;

  if (minimumOutput <= 0n) {
    throw new Error('Slippage tolerance too high; minimum output would be zero');
  }

  return minimumOutput;
}

/**
 * Build a swap transaction from a routing quote.
 * 
 * Constructs the transaction data that will be signed and submitted.
 * 
 * @param params Swap transaction parameters
 * @returns Transaction object ready for signing
 */
export function buildSwapTransaction(params: SwapTransactionParams): SwapTransaction {
  const {
    quote,
    slippageTolerance,
    userAddress,
    swapContract,
    inputAmount,
    inputTokenDecimals,
    outputTokenDecimals,
    isNativeInput,
  } = params;

  // Validate inputs
  if (!quote.callData) {
    throw new Error('Quote missing callData; cannot build transaction');
  }

  if (!quote.outputAmount) {
    throw new Error('Quote missing outputAmount');
  }

  // Convert decimal slippage tolerance to integer basis points (e.g. 0.005 → 50).
  const rawBps = Math.round(slippageTolerance * 10000);
  if (!Number.isFinite(rawBps) || rawBps < 0 || rawBps > 5000) {
    throw new Error('slippageTolerance must be between 0 and 0.5 (0 %–50 %)');
  }
  const slippageBps = rawBps;

  // Calculate minimum output with slippage
  const expectedOutput = parseAmountToBaseUnits(quote.outputAmount, outputTokenDecimals, 'Quote output');
  const minOutput = calculateMinimumOutput(expectedOutput, slippageBps);
  const resolvedSwapContract = (quote.swapContract ?? swapContract) as Address | undefined;

  // Encode minOutput into the calldata that the wallet signs so the router
  // enforces the slippage constraint on-chain.
  const callData = encodeSlippageIntoCallData(quote.callData, minOutput.toString());

  if (!resolvedSwapContract) {
    throw new Error('Quote missing swap contract; cannot build transaction');
  }

  return {
    to: resolvedSwapContract,
    from: userAddress,
    data: callData as Hex,
    value: isNativeInput
      ? parseAmountToBaseUnits(inputAmount, inputTokenDecimals, 'Input')
      : BigInt(0),
    estimatedGas: quote.estimatedGas ? BigInt(quote.estimatedGas) : undefined,
    minOutput,
    expectedOutput,
  };
}

/**
 * Encode minimum output into swap call data.
 *
 * Decodes the existing calldata using the Shell DEX router ABI, replaces the
 * `amountOutMinimum` parameter with `minOutput`, and re-encodes it with
 * `viem`'s `encodeFunctionData`.  This ensures the wallet signs – and the
 * router contract enforces – the slippage limit computed by
 * `calculateMinimumOutput`.
 *
 * If the calldata does not decode against the known ABI, the function throws.
 * Failing closed is safer than sending a swap without `amountOutMinimum`
 * rewritten into the signed calldata.
 *
 * @param originalCallData Hex calldata string from the routing quote
 * @param minOutput        Minimum acceptable output, as a decimal string (token base units)
 * @returns Updated calldata with `amountOutMinimum` set to `minOutput`
 */
export function encodeSlippageIntoCallData(
  originalCallData: string,
  minOutput: string,
  _routerInterface?: string
): string {
  try {
    const decoded = decodeFunctionData({
      abi: SHELL_DEX_ROUTER_ABI,
      data: originalCallData as Hex,
    });

    // args = [tokenIn, tokenOut, amountIn, amountOutMinimum, recipient, deadline]
    const [tokenIn, tokenOut, amountIn, , recipient, deadline] = decoded.args;

    return encodeFunctionData({
      abi: SHELL_DEX_ROUTER_ABI,
      functionName: 'swap',
      args: [tokenIn, tokenOut, amountIn, BigInt(minOutput), recipient, deadline],
    });
  } catch (error) {
    throw new Error(
      `encodeSlippageIntoCallData failed to decode calldata against SHELL_DEX_ROUTER_ABI: ` +
      `${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
}

/**
 * Validate swap transaction before submission.
 * 
 * @param tx Transaction to validate
 * @returns Validation result with any error messages
 */
export function validateSwapTransaction(tx: SwapTransaction): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!tx.to || !isAddress(tx.to)) {
    errors.push('Invalid router contract address');
  }

  if (!tx.from || !isAddress(tx.from)) {
    errors.push('Invalid user address');
  }

  if (!tx.data || !tx.data.startsWith('0x')) {
    errors.push('Invalid transaction data');
  }

  if (tx.minOutput <= BigInt(0)) {
    errors.push('Minimum output must be greater than zero');
  }

  if (tx.minOutput > tx.expectedOutput) {
    errors.push('Minimum output cannot exceed expected output');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function parseAmountToBaseUnits(
  amount: string,
  decimals: number,
  label: string
): bigint {
  const normalized = amount.trim();
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`${label} token decimals are invalid`);
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`${label} amount must be a positive decimal value`);
  }
  const fractionalDigits = normalized.split('.')[1]?.length ?? 0;
  if (fractionalDigits > decimals) {
    throw new Error(`${label} amount is invalid for token decimals`);
  }
  let parsed: bigint;
  try {
    parsed = parseUnits(normalized, decimals);
  } catch {
    throw new Error(`${label} amount is invalid for token decimals`);
  }
  if (parsed <= 0n) {
    throw new Error(`${label} amount must be greater than zero`);
  }
  return parsed;
}
