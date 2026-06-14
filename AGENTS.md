# AGENTS.md — shell-dex

Local single-source-of-truth for AI agents working inside this repository.
This file is fully self-contained; it does not reference any file outside
this submodule.

## What this repo is

Decentralized exchange frontend for **shell-chain** — a
post-quantum-native Layer 1. Next.js application providing the swap and
trading UX. Talks to chain via the shell-sdk client.

## Quick commands

```bash
npm install
npm run dev
npm run build
npm run lint
npm run typecheck
```

## Cardinal rules

1. **Use the SDK** for all chain interaction. Do not import raw chain
   wire-format helpers directly into UI code; let the SDK provide the
   typed surface.
2. **Track the SDK version pin**. Whenever the chain bumps its RPC,
   bump the `shell-sdk` dependency to the corresponding version and
   re-test before shipping.
3. **No client-side private keys**. The DEX UI signs only via the
   wallet extension (e.g., shella-chrome-wallet) — it never holds
   secret-key material.
4. **AA-aware UX**: when an Account Abstraction bundle is available
   (batch swap, sponsored gas, session key), prefer it over multiple
   sequential transactions to reduce user signing friction.

## Quality gates

A change is mergeable when:

- `npm run lint` passes
- `npm run typecheck` passes
- `npm run build` succeeds
- New flows have at least one playwright/e2e or manual smoke test
- No secrets, RPC credentials, or signing keys land in source

## Commit / PR conventions

- **Conventional Commits**: `<type>(<scope>): <subject>` —
  `type ∈ {feat, fix, docs, test, refactor, chore, ci}`.
- Commit messages and code comments are **English**.
- AI-authored commits include a `Co-authored-by: Copilot
  <223556219+Copilot@users.noreply.github.com>` trailer; AI-authored
  PR/Issue bodies start with `🤖 本 [Issue/PR] 由 AI Agent 创建`
  (literal template — do not translate).

## Things to never commit

`.env`, build artifacts, `node_modules/`, any private keys.

## Tool pointers (this file is the SSoT)

- `CLAUDE.md` → read this file
