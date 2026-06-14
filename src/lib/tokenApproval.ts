/**
 * ERC20 token approval management for M3 swap execution.
 *
 * Handles:
 * - Allowance checking
 * - Approval transaction building
 * - Unlimited vs. exact amount approval strategies
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  zeroAddress,
} from 'viem';

export interface AllowanceCheckResult {
  currentAllowance: bigint;
  isApprovalNeeded: boolean;
  approvalAmount: bigint;
}

export interface ApprovalTransactionData {
  to: Address;
  data: Hex;
  value: bigint;
}

export const NATIVE_TOKEN_ADDRESS = zeroAddress;

export function isNativeTokenAddress(tokenAddress: Address): boolean {
  return tokenAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS;
}

/**
 * Check if token approval is needed for a swap.
 * 
 * @param tokenAddress ERC20 token address
 * @param spenderAddress The router/swap contract address
 * @param ownerAddress The user's wallet address
 * @param requiredAmount The amount of token needed for the swap (as wei string)
 * @param publicClient Viem PublicClient for reading from chain
 * @returns Allowance check result with approval recommendation
 */
export async function checkAllowance(
  tokenAddress: Address,
  spenderAddress: Address,
  ownerAddress: Address,
  requiredAmount: bigint,
  publicClient: PublicClient
): Promise<AllowanceCheckResult> {
  if (isNativeTokenAddress(tokenAddress)) {
    return {
      currentAllowance: maxUint256,
      isApprovalNeeded: false,
      approvalAmount: BigInt(0),
    };
  }

  try {
    const currentAllowance = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [ownerAddress, spenderAddress],
    });

    const isApprovalNeeded = currentAllowance < requiredAmount;

    return {
      currentAllowance,
      isApprovalNeeded,
      approvalAmount: requiredAmount,
    };
  } catch (error) {
    console.error('Failed to check token allowance:', error);
    throw new Error(`Could not verify token allowance: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Build an ERC20 approval transaction.
 *
 * Default strategy is `'exact'`: approves only the swap amount so the router
 * cannot transfer more tokens than the current swap requires.
 *
 * Infinite (`maxUint256`) approval requires an explicit `strategy: 'unlimited'`
 * opt-in.  Callers that enable this MUST surface the warning string exported
 * below in their UI before sending the transaction.
 *
 * @param tokenAddress   ERC20 token address
 * @param spenderAddress The router/swap contract address
 * @param strategy       `'exact'` (default, secure) or `'unlimited'` (opt-in)
 * @param exactAmount    Amount to approve (required when strategy is `'exact'`)
 * @returns Transaction call data for the approval
 */
export function buildApprovalTransaction(
  tokenAddress: Address,
  spenderAddress: Address,
  strategy: 'unlimited' | 'exact' = 'exact',
  exactAmount?: bigint
): ApprovalTransactionData {
  const approvalAmount = strategy === 'unlimited'
    ? maxUint256
    : exactAmount;

  if (approvalAmount === undefined) {
    throw new Error('exactAmount required when strategy is "exact"');
  }

  return {
    to: tokenAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spenderAddress, approvalAmount],
    }),
    value: BigInt(0),
  };
}

/**
 * Warning copy that MUST be shown in the UI when infinite approval is enabled.
 */
export const INFINITE_APPROVAL_WARNING =
  '⚠️ Granting unlimited approval — the router can transfer any amount of this token at any time.';

/**
 * Parse approval transaction response from signed TX.
 * 
 * @param txHash Transaction hash from approval
 * @returns True if approval was likely successful (not a guarantee; must check receipt)
 */
export function isApprovalPending(txHash: string): boolean {
  return !!(txHash && txHash.startsWith('0x') && txHash.length === 66);
}
