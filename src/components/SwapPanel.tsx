/**
 * Swap panel for shell-dex quote selection and execution.
 */

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { useSwapState, useSwapExecution, getSwapStageMessage, SwapStage } from '@/hooks';
import { getTokensForChain } from '@/config/tokens';
import { supportedChains, type SupportedChainId } from '@/config/chains';
import { type SwapQuote } from '@/lib/swapRouter';
import { INFINITE_APPROVAL_WARNING } from '@/lib/tokenApproval';
import { ReceiptModal, useReceiptModal } from '@/components/ReceiptModal';
import { RouteSelector } from '@/components/RouteSelector';
import { useMounted } from '@/hooks/useMounted';
import { TokenIcon } from './TokenIcon';

const DEFAULT_SLIPPAGE = 0.005;
const MIN_SLIPPAGE_PERCENT = 0;
const MAX_SLIPPAGE_PERCENT = 50;
const SLIDER_MIN_PERCENT = 0.1;
const SLIDER_MAX_PERCENT = 5;
const SLIPPAGE_PRESETS = [0.1, 0.5, 1];
const SHELL_DEX_ROUTER_ADDRESS =
  process.env.NEXT_PUBLIC_SHELL_DEX_ROUTER_ADDRESS || '0x0000000000000000000000000000000000000000';

export function SwapPanel() {
  const mounted = useMounted();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const swap = useSwapState();
  const execution = useSwapExecution();
  const receiptModal = useReceiptModal();

  const [showInputTokens, setShowInputTokens] = useState(false);
  const [showOutputTokens, setShowOutputTokens] = useState(false);
  const [slippageTolerance, setSlippageTolerance] = useState(DEFAULT_SLIPPAGE);
  /** Infinite-approval opt-in. Defaults OFF (exact-amount approval). */
  const [infiniteApproval, setInfiniteApproval] = useState(false);

  const supportedChainId = chainId as SupportedChainId;
  const availableTokens = getTokensForChain(supportedChainId);
  const chain = supportedChains[supportedChainId];
  const resolvedSwapContract =
    (swap.selectedRoute?.swapContract || swap.quote?.swapContract || SHELL_DEX_ROUTER_ADDRESS) as `0x${string}`;
  const swapReadinessError = useMemo(() => {
    if (!swap.quote) return null;
    if (swap.quoteExpired) return 'Quote expired. Refresh before submitting.';
    if (!swap.quote.callData) {
      return swap.selectedRoute?.isSimulated
        ? 'Selected route is simulated and cannot be executed with live transaction data.'
        : 'This quote has no executable transaction data yet.';
    }
    if (!resolvedSwapContract || resolvedSwapContract === '0x0000000000000000000000000000000000000000') {
      return 'Swap router address is not configured.';
    }
    return null;
  }, [resolvedSwapContract, swap.quote, swap.quoteExpired, swap.selectedRoute?.isSimulated]);

  useEffect(() => {
    if (execution.state.receipt) {
      receiptModal.show(execution.state.receipt);
    }
  }, [execution.state.receipt, receiptModal.show]);

  const handleSwapTokens = () => {
    if (swap.inputToken && swap.outputToken) {
      swap.setInputToken(swap.outputToken);
      swap.setOutputToken(swap.inputToken);
    }
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    swap.setInputAmount(value);
    if (value && swap.outputToken) {
      const timer = setTimeout(() => {
        if (value === e.target.value) {
          swap.refreshQuote();
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  };

  const handleOutputAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    swap.setOutputAmount(value);
    if (value && swap.inputToken) {
      const timer = setTimeout(() => {
        if (value === e.target.value) {
          swap.refreshQuote();
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  };

  const handleSlippageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (Number.isNaN(value)) return;

    const clampedValue = Math.min(Math.max(value, MIN_SLIPPAGE_PERCENT), MAX_SLIPPAGE_PERCENT);
    setSlippageTolerance(clampedValue / 100);
  };

  const slippagePercent = slippageTolerance * 100;
  const slippageTone =
    slippagePercent > 3
      ? 'border-orange-200 bg-orange-50 text-orange-700'
      : slippagePercent > 1
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700';
  const slippageHint =
    slippagePercent > 3
      ? 'High tolerance. Only use this for volatile pairs.'
      : slippagePercent > 1
        ? 'Balanced for faster execution on moving markets.'
        : 'Tighter pricing with lower execution tolerance.';

  const handleSwap = async () => {
    if (!swap.inputToken || !swap.outputToken || !swap.quote || !swap.inputAmount) {
      console.error('Missing swap parameters');
      return;
    }

    await execution.executeSwap({
      quote: swap.quote as SwapQuote,
      slippageTolerance,
      swapContract: resolvedSwapContract,
      tokenAddress: swap.inputToken.addresses[supportedChainId] as `0x${string}`,
      inputToken: swap.inputToken,
      outputToken: swap.outputToken,
      infiniteApproval,
      onSuccess: () => {
        swap.setInputAmount('');
      },
      onError: error => {
        console.error('Swap failed:', error);
      },
    });
  };

  const canSubmitSwap =
    swap.inputToken &&
    swap.outputToken &&
    swap.quote &&
    swap.inputAmount &&
    !swap.quoteExpired &&
    !swapReadinessError &&
    !swap.isLoadingQuote &&
    !execution.state.isLoading;

  const shellCardClass = 'border border-gray-200 rounded-2xl bg-white shadow-sm';

  if (!mounted) {
    return (
      <div className={`${shellCardClass} p-4`}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Swap</h2>
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600">
            Compact
          </span>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-center">
          <p className="text-gray-600 mb-2">Connect your wallet to swap tokens</p>
        </div>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className={`${shellCardClass} p-4`}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Swap</h2>
          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
            Wallet required
          </span>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-center">
          <p className="text-gray-600 mb-2">Connect your wallet to swap tokens</p>
        </div>
      </div>
    );
  }

  if (!chain) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4 shadow-sm">
        <h2 className="mb-2 text-lg font-semibold text-red-900">Unsupported Network</h2>
        <p className="text-red-700 text-sm">
          Please switch to Arbitrum One or Shell Testnet to use the DEX.
        </p>
      </div>
    );
  }

  return (
    <div className={`${shellCardClass} p-4`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Swap</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {chain.name} • route-aware execution
          </p>
        </div>
        <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
          MVP
        </span>
      </div>

      <div className="space-y-3">
        <div className="relative rounded-2xl border border-gray-200 bg-gray-50/80 p-3">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">From</label>
            {swap.inputToken && (
              <span className="text-[11px] text-gray-500">Sell token</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowInputTokens(!showInputTokens)}
              className="min-w-[44%] flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left text-sm font-medium hover:bg-gray-50"
              disabled={execution.state.isLoading}
            >
              {swap.inputToken ? (
                <span className="flex items-center gap-2">
                  <TokenIcon token={swap.inputToken} size={20} />
                  {swap.inputToken.symbol}
                </span>
              ) : (
                <span className="text-gray-500">Select token...</span>
              )}
            </button>
            <input
              type="number"
              placeholder="0"
              value={swap.inputAmount}
              onChange={handleAmountChange}
              disabled={execution.state.isLoading}
              className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 font-mono text-right text-sm disabled:bg-gray-100"
            />
          </div>

          {showInputTokens && (
            <div className="absolute inset-x-3 top-full z-20 mt-2 rounded-xl border border-gray-200 bg-white shadow-lg">
              {availableTokens.map(token => (
                <button
                  key={token.id}
                  onClick={() => {
                    swap.setInputToken(token);
                    setShowInputTokens(false);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-gray-100"
                >
                  <TokenIcon token={token} size={18} />
                  <span>{token.symbol} - {token.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="-my-1 flex justify-center">
          <button
            onClick={handleSwapTokens}
            disabled={!swap.inputToken || !swap.outputToken || execution.state.isLoading}
            className="relative z-10 rounded-full border border-gray-200 bg-white p-2 shadow-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Swap tokens"
          >
            ⇅
          </button>
        </div>

        <div className="relative rounded-2xl border border-gray-200 bg-gray-50/80 p-3">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">To</label>
            {swap.outputToken && (
              <span className="text-[11px] text-gray-500">Buy token</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowOutputTokens(!showOutputTokens)}
              className="min-w-[44%] flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left text-sm font-medium hover:bg-gray-50"
              disabled={execution.state.isLoading}
            >
              {swap.outputToken ? (
                <span className="flex items-center gap-2">
                  <TokenIcon token={swap.outputToken} size={20} />
                  {swap.outputToken.symbol}
                </span>
              ) : (
                <span className="text-gray-500">Select token...</span>
              )}
            </button>
            <input
              type="number"
              placeholder="0"
              value={swap.outputAmount}
              onChange={handleOutputAmountChange}
              disabled={execution.state.isLoading}
              className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 font-mono text-right text-sm text-gray-900 disabled:bg-gray-100"
            />
          </div>

          {showOutputTokens && (
            <div className="absolute inset-x-3 top-full z-20 mt-2 rounded-xl border border-gray-200 bg-white shadow-lg">
              {availableTokens.map(token => (
                <button
                  key={token.id}
                  onClick={() => {
                    swap.setOutputToken(token);
                    setShowOutputTokens(false);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-gray-100"
                >
                  <TokenIcon token={token} size={18} />
                  <span>{token.symbol} - {token.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {swap.quote && (
          <RouteSelector
            routes={swap.availableRoutes}
            selectedRouteId={swap.selectedRouteId}
            outputSymbol={swap.outputToken?.symbol}
            disabled={execution.state.isLoading || swap.isLoadingQuote}
            onSelectRoute={swap.selectRoute}
          />
        )}

        {swap.quote && (
          <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3">
            <div className="space-y-1.5 text-sm">
              {swap.selectedRoute && (
                <div className="flex justify-between gap-4">
                  <span className="text-gray-700">Selected Route:</span>
                  <span className="font-medium text-right">{swap.selectedRoute.routeString}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-700">Fee:</span>
                <span className="font-medium">
                  {swap.quote.fees.total} ({swap.quote.fees.percentage.toFixed(2)}%)
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Price Impact:</span>
                <span className="font-medium">{swap.quote.priceImpact.toFixed(2)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Min. Received:</span>
                <span className="font-medium">
                  {swap.quote.minReceived} {swap.outputToken?.symbol}
                </span>
              </div>
              {swap.quote.estimatedGas && (
                <div className="flex justify-between">
                  <span className="text-gray-700">Est. Gas:</span>
                  <span className="font-medium text-xs font-mono">{swap.quote.estimatedGas} gas</span>
                </div>
              )}
              {swap.quoteExpired && (
                <div className="text-xs text-orange-600 font-medium">Quote expired - refresh recommended</div>
              )}
              {swapReadinessError && (
                <div className="text-xs text-orange-700 font-medium">{swapReadinessError}</div>
              )}
            </div>
          </div>
        )}

        {swap.quote && (
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <label className="text-sm font-medium text-gray-700">Slippage tolerance</label>
                <p className="mt-0.5 text-xs text-gray-500">Control price movement tolerance before execution.</p>
              </div>
              <div className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${slippageTone}`}>
                {slippagePercent.toFixed(2)}%
              </div>
            </div>

            <div className="mb-3 flex flex-wrap gap-2">
              {SLIPPAGE_PRESETS.map((preset) => {
                const selected = Math.abs(slippagePercent - preset) < 0.001;

                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setSlippageTolerance(preset / 100)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                      selected
                        ? 'border-blue-200 bg-blue-50 text-blue-700'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-blue-200 hover:text-blue-700'
                    }`}
                  >
                    {preset.toFixed(preset < 1 ? 1 : 0)}%
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-3">
              <span className="text-[11px] font-medium text-gray-400">{SLIDER_MIN_PERCENT}%</span>
              <input
                type="range"
                min={SLIDER_MIN_PERCENT}
                max={SLIDER_MAX_PERCENT}
                step="0.1"
                value={Math.min(Math.max(slippagePercent, SLIDER_MIN_PERCENT), SLIDER_MAX_PERCENT)}
                onChange={handleSlippageChange}
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-gradient-to-r from-emerald-200 via-blue-200 to-orange-200"
              />
              <span className="text-[11px] font-medium text-gray-400">{SLIDER_MAX_PERCENT}%</span>
              <div className="relative w-20 shrink-0">
                <input
                  type="number"
                  min={MIN_SLIPPAGE_PERCENT}
                  max={MAX_SLIPPAGE_PERCENT}
                  step="0.1"
                  value={slippagePercent.toFixed(2)}
                  onChange={handleSlippageChange}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 pr-6 text-right text-sm font-medium text-gray-900"
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                  %
                </span>
              </div>
            </div>

            <p className="mt-2 text-xs text-gray-600">{slippageHint}</p>
          </div>
        )}

        {/* Approval settings */}
        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3">
          <label className="flex cursor-pointer items-center justify-between gap-2">
            <span className="text-sm font-medium text-gray-700">Unlimited token approval</span>
            <button
              type="button"
              role="switch"
              aria-checked={infiniteApproval}
              aria-label="Unlimited token approval"
              onClick={() => setInfiniteApproval(prev => !prev)}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                infiniteApproval ? 'bg-amber-500' : 'bg-gray-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                  infiniteApproval ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </label>
          {infiniteApproval && (
            <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {INFINITE_APPROVAL_WARNING}
            </p>
          )}
          {!infiniteApproval && (
            <p className="mt-1 text-xs text-gray-500">
              Approves only the exact swap amount (recommended).
            </p>
          )}
        </div>

        {execution.state.stage !== SwapStage.IDLE && (
          <div
            className={`rounded-2xl border p-3 ${
              execution.state.stage === SwapStage.SUCCESS
                ? 'border-green-200 bg-green-50'
                : execution.state.stage === SwapStage.ERROR
                  ? 'border-red-200 bg-red-50'
                  : 'border-blue-200 bg-blue-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{getSwapStageMessage(execution.state.stage)}</span>
              {execution.state.isLoading && <span className="inline-block animate-spin text-lg">⟳</span>}
            </div>
            {execution.state.approvalTxHash && (
              <p className="text-xs text-gray-600 mt-1 font-mono">
                Approval: {execution.state.approvalTxHash.slice(0, 10)}...
              </p>
            )}
            {execution.state.swapTxHash && (
              <p className="text-xs text-gray-600 mt-1 font-mono">
                Swap: {execution.state.swapTxHash.slice(0, 10)}...
              </p>
            )}
            {execution.state.error && <p className="text-xs text-red-700 mt-1">{execution.state.error}</p>}
          </div>
        )}

        {swap.quoteError && execution.state.stage === SwapStage.IDLE && (
          <div className="rounded-2xl border border-orange-200 bg-orange-50 p-3">
            <p className="text-sm text-orange-800">{swap.quoteError}</p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            onClick={swap.refreshQuote}
            disabled={
              !swap.inputToken ||
              !swap.outputToken ||
              (!swap.inputAmount && !swap.outputAmount) ||
              swap.isLoadingQuote ||
              execution.state.isLoading
            }
            className="rounded-xl border border-blue-300 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {swap.isLoadingQuote ? 'Loading...' : 'Refresh Quote'}
          </button>
          <button
            onClick={handleSwap}
            disabled={!canSubmitSwap || (execution.state.error !== undefined && execution.state.stage !== SwapStage.IDLE)}
            className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {execution.state.isLoading ? 'Processing...' : 'Swap'}
          </button>
        </div>

        {(execution.state.stage === SwapStage.ERROR ||
          (execution.state.stage !== SwapStage.IDLE && !execution.state.isLoading)) && (
          <div className="flex gap-2">
            {execution.state.stage === SwapStage.ERROR && (
              <button
                onClick={execution.retry}
                className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50"
              >
                Retry
              </button>
            )}
            <button
              onClick={execution.reset}
              className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50"
            >
              Reset
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 rounded-2xl border border-green-200 bg-green-50 p-3">
        <p className="text-xs text-green-800">
          <span className="font-semibold">M3 Ready:</span> Transaction execution, slippage control,
          route selection, and approval flows are now wired together.
        </p>
      </div>

      <ReceiptModal
        isOpen={receiptModal.isOpen}
        receipt={receiptModal.receipt}
        onClose={() => {
          receiptModal.close();
          execution.reset();
        }}
      />
    </div>
  );
}
