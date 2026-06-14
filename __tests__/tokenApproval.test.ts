/**
 * Tests for DEX-CRIT-2: ERC-20 approval amount security.
 *
 * Verifies:
 * 1. Default code path generates approve(spender, swapAmount) – NOT maxUint256.
 * 2. Infinite approval requires explicit opt-in and produces maxUint256.
 * 3. INFINITE_APPROVAL_WARNING is exported and non-empty.
 */

import { describe, it, expect } from 'vitest';
import { decodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import {
  buildApprovalTransaction,
  INFINITE_APPROVAL_WARNING,
} from '../src/lib/tokenApproval';

const TOKEN   = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const SPENDER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

describe('buildApprovalTransaction – DEX-CRIT-2', () => {
  it('default strategy produces approve(spender, swapAmount) – NOT maxUint256', () => {
    const swapAmount = 1_000_000n; // e.g. 1 USDC
    const tx = buildApprovalTransaction(TOKEN, SPENDER, 'exact', swapAmount);

    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe('approve');

    const [spender, amount] = decoded.args as [`0x${string}`, bigint];
    expect(spender.toLowerCase()).toBe(SPENDER.toLowerCase());
    expect(amount).toBe(swapAmount);
    expect(amount).not.toBe(maxUint256);
  });

  it('default strategy (no strategy arg) also uses exact amount', () => {
    const swapAmount = 42n;
    const tx = buildApprovalTransaction(TOKEN, SPENDER, undefined, swapAmount);

    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    const [, amount] = decoded.args as [`0x${string}`, bigint];
    expect(amount).toBe(swapAmount);
    expect(amount).not.toBe(maxUint256);
  });

  it('unlimited strategy produces approve(spender, maxUint256)', () => {
    const tx = buildApprovalTransaction(TOKEN, SPENDER, 'unlimited');

    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    const [, amount] = decoded.args as [`0x${string}`, bigint];
    expect(amount).toBe(maxUint256);
  });

  it('throws when strategy is "exact" but exactAmount is omitted', () => {
    expect(() => buildApprovalTransaction(TOKEN, SPENDER, 'exact')).toThrow();
  });

  it('INFINITE_APPROVAL_WARNING is a non-empty string and mentions unlimited', () => {
    expect(typeof INFINITE_APPROVAL_WARNING).toBe('string');
    expect(INFINITE_APPROVAL_WARNING.length).toBeGreaterThan(0);
    expect(INFINITE_APPROVAL_WARNING.toLowerCase()).toContain('unlimited');
  });
});
