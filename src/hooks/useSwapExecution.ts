'use client';

import { useCallback, useState } from 'react';
import { BaseError, useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi';
import {
  type Address,
  type PublicClient,
  type TransactionReceipt,
  formatUnits,
  parseUnits,
} from 'viem';
import type { SupportedChainId } from '@/config/chains';
import { supportedChains } from '@/config/chains';
import type { Token } from '@/config/tokens';
import type { TransactionReceiptData } from '@/components/ReceiptModal';
import {
  buildSwapTransactionActivity,
  recordTransactionActivity,
} from '@/lib/activityHistory';
import { type SwapQuote } from '@/lib/swapRouter';
import {
  buildApprovalTransaction,
  checkAllowance,
  INFINITE_APPROVAL_WARNING,
  isNativeTokenAddress,
} from '@/lib/tokenApproval';
import {
  buildSwapTransaction,
  validateSwapTransaction,
} from '@/lib/swapTransaction';

export enum SwapStage {
  IDLE = 'idle',
  CHECKING_ALLOWANCE = 'checking_allowance',
  AWAITING_APPROVAL = 'awaiting_approval',
  APPROVAL_PENDING = 'approval_pending',
  APPROVAL_CONFIRMED = 'approval_confirmed',
  SUBMITTING_SWAP = 'submitting_swap',
  SWAP_PENDING = 'swap_pending',
  SUCCESS = 'success',
  ERROR = 'error',
}

export interface SwapExecutionState {
  stage: SwapStage;
  approvalTxHash?: string;
  swapTxHash?: string;
  swapReceipt?: TransactionReceipt;
  receipt?: TransactionReceiptData;
  error?: string;
  isLoading: boolean;
}

export interface SwapExecutionParams {
  quote: SwapQuote;
  slippageTolerance: number;
  swapContract?: Address;
  tokenAddress: Address;
  inputToken: Token;
  outputToken: Token;
  /**
   * When true the approval transaction uses maxUint256 instead of the exact
   * swap amount.  Defaults to false (exact-amount approval).
   * Callers MUST display INFINITE_APPROVAL_WARNING before setting this to true.
   */
  infiniteApproval?: boolean;
  onSuccess?: (receipt: TransactionReceiptData) => void;
  onError?: (error: Error) => void;
}

const INITIAL_STATE: SwapExecutionState = {
  stage: SwapStage.IDLE,
  isLoading: false,
};

export function useSwapExecution() {
  const { address: userAddress } = useAccount();
  const chainId = useChainId() as SupportedChainId | undefined;
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });
  const [state, setState] = useState<SwapExecutionState>(INITIAL_STATE);

  const executeSwap = useCallback(
    async (params: SwapExecutionParams) => {
      const {
        quote,
        slippageTolerance,
        swapContract,
        tokenAddress,
        inputToken,
        outputToken,
        infiniteApproval = false,
        onSuccess,
        onError,
      } = params;

      if (!userAddress || !chainId || !walletClient || !publicClient) {
        const error = new Error('Wallet connection is not ready. Reconnect and try again.');
        setState({
          ...INITIAL_STATE,
          stage: SwapStage.ERROR,
          error: error.message,
        });
        onError?.(error);
        return;
      }

      if (!quote.callData) {
        const error = new Error('This quote is not executable. Refresh for a live route and try again.');
        setState({
          ...INITIAL_STATE,
          stage: SwapStage.ERROR,
          error: error.message,
        });
        onError?.(error);
        return;
      }

      try {
        setState({
          ...INITIAL_STATE,
          stage: SwapStage.CHECKING_ALLOWANCE,
          isLoading: true,
        });

        const inputAmount = quote.inputAmount ?? '0';
        const requiredInputAmount = toBaseUnits(inputAmount, inputToken.decimals, inputToken.symbol);
        const resolvedSwapContract = (quote.swapContract ?? swapContract) as Address | undefined;

        if (!resolvedSwapContract) {
          throw new Error('Swap router address is missing for this quote.');
        }

        const allowanceCheckResult = await checkAllowance(
          tokenAddress,
          resolvedSwapContract,
          userAddress,
          requiredInputAmount,
          publicClient
        );

        if (allowanceCheckResult.isApprovalNeeded) {
          setState(prev => ({
            ...prev,
            stage: SwapStage.AWAITING_APPROVAL,
          }));

          // Default: approve the exact swap amount only (DEX-CRIT-2 fix).
          // Infinite approval requires an explicit opt-in with UI warning.
          const approvalData = buildApprovalTransaction(
            tokenAddress,
            resolvedSwapContract,
            infiniteApproval ? 'unlimited' : 'exact',
            infiniteApproval ? undefined : requiredInputAmount
          );

          if (infiniteApproval) {
            console.warn('[useSwapExecution] ' + INFINITE_APPROVAL_WARNING);
          }

          const approvalTxHash = await walletClient.sendTransaction({
            account: userAddress,
            to: approvalData.to,
            data: approvalData.data,
            value: approvalData.value,
          });

          setState(prev => ({
            ...prev,
            stage: SwapStage.APPROVAL_PENDING,
            approvalTxHash,
          }));

          const approvalReceipt = await publicClient.waitForTransactionReceipt({
            hash: approvalTxHash,
          });

          if (approvalReceipt.status !== 'success') {
            throw new Error('Approval transaction reverted.');
          }

          setState(prev => ({
            ...prev,
            stage: SwapStage.APPROVAL_CONFIRMED,
          }));
        } else {
          setState(prev => ({
            ...prev,
            stage: SwapStage.APPROVAL_CONFIRMED,
          }));
        }

        setState(prev => ({
          ...prev,
          stage: SwapStage.SUBMITTING_SWAP,
        }));

        const swapTx = buildSwapTransaction({
          quote,
          slippageTolerance,
          userAddress,
          swapContract: resolvedSwapContract,
          inputAmount,
          inputTokenDecimals: inputToken.decimals,
          outputTokenDecimals: outputToken.decimals,
          isNativeInput: isNativeTokenAddress(tokenAddress),
        });

        const validation = validateSwapTransaction(swapTx);
        if (!validation.valid) {
          throw new Error(`Invalid swap transaction: ${validation.errors.join(', ')}`);
        }

        const swapTxHash = await walletClient.sendTransaction({
          account: userAddress,
          to: swapTx.to,
          data: swapTx.data,
          value: swapTx.value,
          gas: swapTx.estimatedGas,
        });

        setState(prev => ({
          ...prev,
          stage: SwapStage.SWAP_PENDING,
          swapTxHash,
        }));

        const swapReceipt = await publicClient.waitForTransactionReceipt({
          hash: swapTxHash,
        });

        const receiptData = await buildReceiptData({
          receipt: swapReceipt,
          chainId,
          inputToken,
          outputToken,
          inputAmount: quote.inputAmount,
          outputAmount: quote.outputAmount,
          publicClient,
        });
        recordTransactionActivity(
          buildSwapTransactionActivity({
            chainId,
            owner: userAddress,
            receipt: receiptData,
            inputToken,
            outputToken,
            inputAmount: quote.inputAmount,
            outputAmount: quote.outputAmount,
          })
        );

        if (swapReceipt.status !== 'success') {
          throw new SwapExecutionError('Swap transaction reverted.', receiptData, swapReceipt, swapTxHash);
        }

        setState(prev => ({
          ...prev,
          stage: SwapStage.SUCCESS,
          swapTxHash,
          swapReceipt,
          receipt: receiptData,
          isLoading: false,
        }));

        onSuccess?.(receiptData);
      } catch (error) {
        const normalizedError = normalizeSwapError(error);
        setState(prev => ({
          ...prev,
          stage: SwapStage.ERROR,
          swapTxHash: normalizedError.swapTxHash ?? prev.swapTxHash,
          swapReceipt: normalizedError.receipt ?? prev.swapReceipt,
          receipt: normalizedError.receiptData ?? prev.receipt,
          error: normalizedError.message,
          isLoading: false,
        }));
        onError?.(normalizedError);
      }
    },
    [chainId, publicClient, userAddress, walletClient]
  );

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const retry = useCallback(() => {
    if (state.stage === SwapStage.ERROR) {
      reset();
    }
  }, [reset, state.stage]);

  return {
    state,
    executeSwap,
    reset,
    retry,
  };
}

export function getSwapStageMessage(stage: SwapStage): string {
  const messages: Record<SwapStage, string> = {
    [SwapStage.IDLE]: 'Ready to swap',
    [SwapStage.CHECKING_ALLOWANCE]: 'Checking token allowance...',
    [SwapStage.AWAITING_APPROVAL]: 'Confirm the approval in your wallet...',
    [SwapStage.APPROVAL_PENDING]: 'Approval submitted. Waiting for confirmation...',
    [SwapStage.APPROVAL_CONFIRMED]: 'Token approval confirmed',
    [SwapStage.SUBMITTING_SWAP]: 'Confirm the swap in your wallet...',
    [SwapStage.SWAP_PENDING]: 'Swap submitted. Waiting for confirmation...',
    [SwapStage.SUCCESS]: 'Swap completed!',
    [SwapStage.ERROR]: 'Swap failed',
  };
  return messages[stage];
}

async function buildReceiptData({
  receipt,
  chainId,
  inputToken,
  outputToken,
  inputAmount,
  outputAmount,
  publicClient,
}: {
  receipt: TransactionReceipt;
  chainId: SupportedChainId;
  inputToken: Token;
  outputToken: Token;
  inputAmount: string;
  outputAmount: string;
  publicClient: PublicClient;
}): Promise<TransactionReceiptData> {
  const block = await publicClient.getBlock({ blockHash: receipt.blockHash });
  const chain = supportedChains[chainId];
  const feeAmount = receipt.effectiveGasPrice
    ? formatFeeAmount(receipt.gasUsed * receipt.effectiveGasPrice, chain.nativeCurrency.decimals)
    : undefined;

  return {
    transactionHash: receipt.transactionHash,
    status: receipt.status === 'success' ? 'success' : 'failed',
    title: receipt.status === 'success' ? 'Swap Successful' : 'Swap Failed',
    summary: `${inputToken.symbol} → ${outputToken.symbol}`,
    items: [
      {
        label: 'From',
        value: `${inputAmount} ${inputToken.symbol}`,
      },
      {
        label: 'To',
        value: `${outputAmount} ${outputToken.symbol}`,
        tone: receipt.status === 'success' ? 'success' : 'danger',
      },
    ],
    fee: feeAmount
      ? {
          amount: feeAmount,
          currency: chain.nativeCurrency.symbol,
        }
      : undefined,
    blockNumber: Number(receipt.blockNumber),
    blockTime: Number(block.timestamp),
    confirmations: 1,
    chainId,
  };
}

function toBaseUnits(amount: string, decimals: number, symbol: string): bigint {
  try {
    return parseUnits(amount, decimals);
  } catch {
    throw new Error(`Invalid ${symbol} amount.`);
  }
}

function formatFeeAmount(amount: bigint, decimals: number): string {
  const formatted = formatUnits(amount, decimals);
  const [whole, fraction = ''] = formatted.split('.');
  return fraction ? `${whole}.${fraction.slice(0, 6)}`.replace(/\.$/, '') : whole;
}

class SwapExecutionError extends Error {
  constructor(
    message: string,
    readonly receiptData?: TransactionReceiptData,
    readonly receipt?: TransactionReceipt,
    readonly swapTxHash?: string
  ) {
    super(message);
  }
}

function normalizeSwapError(error: unknown): SwapExecutionError {
  if (error instanceof SwapExecutionError) {
    return error;
  }

  const message =
    error instanceof BaseError
      ? error.shortMessage
      : error instanceof Error
        ? error.message
        : 'Unknown swap error';

  return new SwapExecutionError(message);
}
