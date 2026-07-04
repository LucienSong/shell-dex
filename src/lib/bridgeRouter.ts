import { type Address, formatUnits, keccak256, parseUnits, stringToHex } from 'viem';
import { getTokenAddress, type Token } from '@/config/tokens';
import { type SupportedChainId, supportedChains } from '@/config/chains';

export const BRIDGE_CHAINS = {
  42161: { name: 'Arbitrum One', bridgeId: 'arbitrum' },
  10: { name: 'Shell Testnet', bridgeId: 'shell-testnet' },
} as const satisfies Partial<Record<SupportedChainId, { name: string; bridgeId: string }>>;

const BRIDGE_PAIR_PROTOCOLS: Record<string, Array<'stargate' | 'custom'>> = {
  '42161:10': ['stargate'],
  '10:42161': ['stargate'],
};

const BRIDGE_QUOTE_TTL_MS = 45_000;
const DEFAULT_BRIDGE_SPENDER =
  (process.env.NEXT_PUBLIC_STARGATE_ROUTER_ADDRESS ||
    '0x0000000000000000000000000000000000000b11') as Address;
const DEFAULT_BRIDGE_EXECUTOR =
  (process.env.NEXT_PUBLIC_STARGATE_EXECUTOR_ADDRESS ||
    '0x0000000000000000000000000000000000000b12') as Address;

export interface BridgeQuote {
  quoteId: string;
  sourceChain: SupportedChainId;
  destinationChain: SupportedChainId;
  token: Token;
  inputAmount: string;
  estimatedOutputAmount: string;
  bridgeFee: {
    amount: string;
    percentage: number;
  };
  estimatedGasSource: string;
  estimatedGasDestination: string;
  estimatedTime: number;
  minReceived: string;
  exchangeRate: string;
  bridgeProtocol: 'stargate' | 'custom';
  routeSteps: string[];
  sourceTokenAddress: Address;
  destinationTokenAddress: Address;
  approvalSpender: Address;
  bridgeExecutor: Address;
  quoteGeneratedAt: number;
  expiresAt: number;
  isSimulated: boolean;
}

export interface BridgeTransactionData {
  to: Address;
  from: Address;
  data: string;
  value: string;
  chainId: SupportedChainId;
  estimatedGas: string;
}

export function getAvailableBridges(
  sourceChain: SupportedChainId,
  destinationChain: SupportedChainId
): Array<'stargate' | 'custom'> {
  return BRIDGE_PAIR_PROTOCOLS[`${sourceChain}:${destinationChain}`] ?? [];
}

export async function getBridgeQuote(
  token: Token,
  amount: string,
  sourceChain: SupportedChainId,
  destinationChain: SupportedChainId
): Promise<BridgeQuote> {
  if (!BRIDGE_CHAINS[sourceChain] || !BRIDGE_CHAINS[destinationChain]) {
    throw new Error(`Unsupported bridge chain: ${sourceChain} → ${destinationChain}`);
  }

  const protocols = getAvailableBridges(sourceChain, destinationChain);
  if (!protocols.length) {
    throw new Error('The selected chain pair is not bridge-enabled yet.');
  }

  const sourceAddr = getTokenAddress(token.id, sourceChain);
  const destinationAddr = getTokenAddress(token.id, destinationChain);

  if (!sourceAddr || !destinationAddr) {
    throw new Error(`Token ${token.symbol} is not available on both chains.`);
  }

  const normalizedAmount = normalizeBridgeAmount(amount, token.decimals, token.symbol);
  return buildDeterministicBridgeQuote(
    token,
    normalizedAmount,
    sourceChain,
    destinationChain,
    sourceAddr as Address,
    destinationAddr as Address,
    protocols[0]
  );
}

function buildDeterministicBridgeQuote(
  token: Token,
  amount: string,
  sourceChain: SupportedChainId,
  destinationChain: SupportedChainId,
  sourceTokenAddress: Address,
  destinationTokenAddress: Address,
  protocol: 'stargate' | 'custom'
): BridgeQuote {
  const amountUnits = parseUnits(amount, token.decimals);
  const amountFloat = Number(formatUnits(amountUnits, token.decimals));
  const variableFeeBps = getVariableFeeBps(token.id, sourceChain, destinationChain);
  const flatFeeFloat = getFlatFeeAmount(token.id);
  const variableFeeFloat = amountFloat * (variableFeeBps / 10_000);
  const bridgeFeeFloat = Math.min(amountFloat * 0.2, flatFeeFloat + variableFeeFloat);
  const outputFloat = Math.max(amountFloat - bridgeFeeFloat, 0);
  const minReceivedFloat = outputFloat * 0.996;
  const quoteGeneratedAt = Date.now();
  const exchangeRate = amountFloat > 0 ? outputFloat / amountFloat : 0;

  return {
    quoteId: keccak256(
      stringToHex(`${token.id}:${amount}:${sourceChain}:${destinationChain}:${quoteGeneratedAt}`)
    ),
    sourceChain,
    destinationChain,
    token,
    inputAmount: amount,
    estimatedOutputAmount: formatDisplayAmount(outputFloat, token.decimals),
    bridgeFee: {
      amount: formatDisplayAmount(bridgeFeeFloat, token.decimals),
      percentage: bridgeFeeFloat > 0 && amountFloat > 0 ? (bridgeFeeFloat / amountFloat) * 100 : 0,
    },
    estimatedGasSource: getEstimatedSourceGas(sourceChain),
    estimatedGasDestination: getEstimatedDestinationGas(destinationChain),
    estimatedTime: getDeterministicEtaSeconds(token.id, sourceChain, destinationChain),
    minReceived: formatDisplayAmount(minReceivedFloat, token.decimals),
    exchangeRate: exchangeRate.toFixed(6),
    bridgeProtocol: protocol,
    routeSteps: [
      `Lock ${token.symbol} on ${supportedChains[sourceChain]?.name}`,
      'Relay the message through the bridge transport',
      `Release ${token.symbol} on ${supportedChains[destinationChain]?.name}`,
    ],
    sourceTokenAddress,
    destinationTokenAddress,
    approvalSpender: DEFAULT_BRIDGE_SPENDER,
    bridgeExecutor: DEFAULT_BRIDGE_EXECUTOR,
    quoteGeneratedAt,
    expiresAt: quoteGeneratedAt + BRIDGE_QUOTE_TTL_MS,
    isSimulated: true,
  };
}

function getVariableFeeBps(
  tokenId: string,
  sourceChain: SupportedChainId,
  destinationChain: SupportedChainId
): number {
  const pairWeight = sourceChain === 42161 && destinationChain === 10 ? 14 : 12;
  const tokenWeight: Record<string, number> = {
    eth: 12,
    shell: 18,
    arb: 16,
    usdc: 8,
    usdt: 9,
    dai: 10,
  };

  return pairWeight + (tokenWeight[tokenId] ?? 10);
}

function getFlatFeeAmount(tokenId: string): number {
  switch (tokenId) {
    case 'eth':
      return 0.0018;
    case 'shell':
      return 0.15;
    case 'arb':
      return 0.09;
    case 'usdc':
    case 'usdt':
      return 0.35;
    default:
      return 0.25;
  }
}

function getDeterministicEtaSeconds(
  tokenId: string,
  sourceChain: SupportedChainId,
  destinationChain: SupportedChainId
): number {
  const base = sourceChain === 42161 && destinationChain === 10 ? 360 : 300;
  const tokenDelta = (tokenId.length % 4) * 45;
  return base + tokenDelta;
}

function getEstimatedSourceGas(chainId: SupportedChainId): string {
  return chainId === 42161 ? '480000' : '340000';
}

function getEstimatedDestinationGas(chainId: SupportedChainId): string {
  return chainId === 42161 ? '240000' : '180000';
}

export function normalizeBridgeAmount(amount: string, decimals: number, symbol: string): string {
  const trimmed = amount.trim();
  if (!trimmed) {
    throw new Error(`Enter a valid ${symbol} amount.`);
  }

  try {
    const amountUnits = parseUnits(trimmed, decimals);
    if (amountUnits <= 0n) {
      throw new Error('amount must be positive');
    }
    return formatUnits(amountUnits, decimals);
  } catch {
    throw new Error(`Enter a valid ${symbol} amount.`);
  }
}

function formatDisplayAmount(value: number, decimals: number): string {
  const maxDigits = Math.min(Math.max(decimals, 2), 6);
  return value.toLocaleString(undefined, {
    minimumFractionDigits: value > 0 && value < 1 ? 2 : 0,
    maximumFractionDigits: maxDigits,
    useGrouping: false,
  });
}

export function buildBridgeTransaction(
  quote: BridgeQuote,
  userAddress: Address
): BridgeTransactionData {
  return {
    to: quote.bridgeExecutor,
    from: userAddress,
    data: keccak256(stringToHex(`${quote.quoteId}:${userAddress}`)),
    value: quote.sourceTokenAddress === '0x0000000000000000000000000000000000000000' ? quote.inputAmount : '0x0',
    chainId: quote.sourceChain,
    estimatedGas: quote.estimatedGasSource,
  };
}

export function validateBridgeTransaction(
  tx: BridgeTransactionData,
  quote: BridgeQuote
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!tx.to || !tx.to.startsWith('0x')) {
    errors.push('Invalid bridge contract address');
  }

  if (!tx.from || !tx.from.startsWith('0x')) {
    errors.push('Invalid user address');
  }

  if (!tx.data || !tx.data.startsWith('0x')) {
    errors.push('Invalid transaction data');
  }

  if (Number(quote.estimatedOutputAmount) <= 0) {
    errors.push('Output amount is zero');
  }

  if (quote.sourceChain === quote.destinationChain) {
    errors.push('Source and destination chains must be different');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function calculateTotalBridgeCost(
  quote: BridgeQuote,
  gasPrice?: string
): { gasCost: string; bridgeFeeUSD: string; totalCostUSD: string } {
  const gasCost = gasPrice ? Number(quote.estimatedGasSource) * Number(gasPrice) : 0;
  const bridgeFee = Number(quote.bridgeFee.amount);
  const totalCost = gasCost + bridgeFee;

  return {
    gasCost: gasCost.toFixed(2),
    bridgeFeeUSD: bridgeFee.toFixed(2),
    totalCostUSD: totalCost.toFixed(2),
  };
}

export async function getBridgeTransactionStatus(
  sourceTxHash: string,
  sourceChain: SupportedChainId,
  destinationChain: SupportedChainId
): Promise<{
  status: 'pending' | 'in_transit' | 'delivered' | 'failed';
  sourceConfirmations: number;
  destinationTxHash?: string;
}> {
  return {
    status: 'in_transit',
    sourceConfirmations: 1,
    destinationTxHash: keccak256(
      stringToHex(`${sourceTxHash}:${sourceChain}:${destinationChain}`)
    ),
  };
}
