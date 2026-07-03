import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadSwapErrorsModule() {
  const sourcePath = join(process.cwd(), 'src/lib/swapErrors.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  });

  const module = { exports: {} };
  const context = vm.createContext({
    Error,
    String,
    console,
    exports: module.exports,
    module,
    require,
  });
  vm.runInContext(outputText, context, { filename: sourcePath });
  return module.exports;
}

const {
  SwapError,
  getErrorDisplay,
  getRecoverySuggestion,
  handleRoutingError,
  isNetworkSwitchError,
  validateInputAmount,
  validateTokenPair,
} = loadSwapErrorsModule();

const eth = {
  id: 'eth',
  symbol: 'ETH',
  name: 'Ethereum',
  decimals: 18,
  addresses: { 42161: '0x0000000000000000000000000000000000000000' },
};

const usdc = {
  id: 'usdc',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  addresses: { 42161: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5F86' },
};

function expectSwapError(fn, expected) {
  expect(fn).toThrow(SwapError);
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject(expected);
    return;
  }
  throw new Error('Expected function to throw a SwapError');
}

test('validateTokenPair accepts distinct tokens', () => {
  expect(() => validateTokenPair(eth, usdc)).not.toThrow();
});

test('validateTokenPair rejects missing and same-token pairs', () => {
  expectSwapError(() => validateTokenPair(undefined, usdc), {
    name: 'SwapError',
    code: 'MISSING_TOKENS',
    recoverable: false,
  });
  expectSwapError(() => validateTokenPair(eth, { ...eth }), {
    name: 'SwapError',
    code: 'SAME_TOKEN',
    recoverable: false,
  });
});

test('validateInputAmount accepts positive values within token decimals', () => {
  expect(() => validateInputAmount('1', 6)).not.toThrow();
  expect(() => validateInputAmount('0.000001', 6)).not.toThrow();
});

test('validateInputAmount rejects empty, zero, negative, malformed, and over-precise values', () => {
  expectSwapError(() => validateInputAmount('', 6), { code: 'ZERO_AMOUNT' });
  expectSwapError(() => validateInputAmount('0', 6), { code: 'ZERO_AMOUNT' });
  expectSwapError(() => validateInputAmount('0.0', 6), { code: 'ZERO_AMOUNT' });
  expectSwapError(() => validateInputAmount('-1', 6), { code: 'INVALID_AMOUNT' });
  expectSwapError(() => validateInputAmount('abc', 6), { code: 'INVALID_AMOUNT' });
  expectSwapError(() => validateInputAmount('1abc', 6), { code: 'INVALID_AMOUNT' });
  expectSwapError(() => validateInputAmount('1e3', 6), { code: 'INVALID_AMOUNT' });
  expectSwapError(() => validateInputAmount('1.', 6), { code: 'INVALID_AMOUNT' });
  expectSwapError(() => validateInputAmount('0.0000001', 6), {
    code: 'TOO_MANY_DECIMALS',
  });
});

test('handleRoutingError maps known failures to safe display errors', () => {
  expect(handleRoutingError(new Error('Failed to fetch')).code).toBe('NETWORK_ERROR');
  expect(handleRoutingError(new Error('No route for pair')).code).toBe('NO_ROUTE_FOUND');
  expect(handleRoutingError(new Error('slippage exceeded')).code).toBe('SLIPPAGE_ERROR');
  expect(handleRoutingError(new Error('insufficient liquidity')).code).toBe(
    'INSUFFICIENT_LIQUIDITY'
  );
});

test('handleRoutingError preserves SwapError instances and falls back safely', () => {
  const original = new SwapError('custom', 'CUSTOM', false);
  expect(handleRoutingError(original)).toBe(original);

  const fallback = handleRoutingError(new Error('quote server unavailable'));
  expect(fallback.code).toBe('QUOTE_ERROR');
  expect(fallback.recoverable).toBe(true);
});

test('isNetworkSwitchError recognizes wallet network mismatch messages', () => {
  expect(isNetworkSwitchError(new Error('chainId mismatch'))).toBe(true);
  expect(isNetworkSwitchError(new Error('wallet switched network'))).toBe(true);
  expect(isNetworkSwitchError(new Error('quote expired'))).toBe(false);
});

test('display and recovery helpers expose safe user-facing text', () => {
  expect(getErrorDisplay(new SwapError('fatal', 'FATAL', false))).toBe('⚠️ fatal');
  expect(
    getRecoverySuggestion(new SwapError('No route', 'NO_ROUTE_FOUND')),
  ).toBe('Try a different token pair or smaller amount.');
  expect(getRecoverySuggestion(new SwapError('custom', 'CUSTOM'))).toBeNull();
});
