// Paying a Kripicard deposit from Robinhood Chain, via Relay.
//
// Why Relay and not a bridge: the card provider settles in USDT on Solana, so
// there is no bridge to take — it is a cross-ecosystem swap. Relay quotes it as
// a REST call, fills in seconds, and needs no contracts and no SDK.
//
// EXACT_OUTPUT, not EXACT_INPUT: the provider credits a deposit only when the
// exact quoted amount arrives at the address. Underpaying by a cent of slippage
// is money sent to an address nobody watches. Verified against the live Relay
// API — 4663 -> Solana USDT quotes fine and delivers the requested amount.
//
// Privacy note: the relayer sees origin address -> destination address, and the
// destination is the card provider's. This leg is public by construction.

import {
  createPublicClient,
  custom,
  defineChain,
  getAddress,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
  type WalletClient,
} from "viem";

// In the browser, RPC goes through our same-origin /api/rpc proxy: some ISPs
// DNS-block the robinhood.com host outright, and the proxy also keeps the
// user's IP away from the RPC operator. On the server, hit the target directly.
const RPC_URL =
  typeof window !== "undefined"
    ? `${window.location.origin}/api/rpc`
    : (process.env.EVM_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com").trim();

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  testnet: true,
});

const RELAY_API = "https://api.relay.link";
/** Relay's sentinel for a chain's native coin. */
const NATIVE: Address = "0x0000000000000000000000000000000000000000";

/** What the user spends on Robinhood Chain. */
export type PayAsset = "ETH" | "USDG";

/** Canonical USDG on Robinhood Chain mainnet, 6 decimals. */
export const USDG_MAINNET: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/** Testnet stand-in ("Test Global Dollar") — the mintable one, for dev. */
export const USDG_TESTNET: Address = "0x732e879F6b873D40383C979b091FE6c3995176eE";

/**
 * Where the provider wants to be paid, in Relay's terms. Keyed by the deposit's
 * own `network:pay_currency` so an unknown rail throws instead of being guessed
 * at — a wrong currency here sends real money to the right address in the wrong
 * asset, which the provider will not credit.
 */
const PAY_RAILS: Record<string, { chainId: number; currency: string; decimals: number }> = {
  "sol:USDT": {
    chainId: 792703809,
    currency: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
  },
};

/** The fields of a Kripicard deposit this module needs. */
export interface PayableDeposit {
  pay_address: string;
  pay_amount: string;
  pay_currency: string;
  network: string;
  expires_at: string;
}

interface RelayTx {
  to: Address;
  data: Hex;
  value: string;
  chainId: number;
}

interface RelayStep {
  id: string;
  description?: string;
  items?: { data: RelayTx; check?: { endpoint: string } }[];
}

export interface PaymentQuote {
  /** What the user spends, already scaled (e.g. "0.0134"). */
  inFormatted: string;
  inSymbol: string;
  inUsd: string;
  /** What the destination receives — the deposit's pay_amount, or the swap output. */
  outFormatted: string;
  outSymbol?: string;
  outUsd: string;
  feeUsd: string;
  etaSeconds: number;
  /** How many wallet signatures this will ask for (approve + swap = 2). */
  txCount: number;
  steps: RelayStep[];
  /** Relay path to poll once the last tx is in, e.g. "/intents/status?...". */
  statusPath?: string;
}

async function relay<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${RELAY_API}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Relay puts the useful part in the body; the status alone says nothing.
    throw new Error(`Relay ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function spendCurrency(asset: PayAsset, chain: Chain): Address {
  if (asset === "ETH") return NATIVE;
  return chain.testnet ? USDG_TESTNET : USDG_MAINNET;
}

/**
 * Quotes paying `deposit` out of the user's Robinhood Chain wallet. Show it and
 * let the user confirm before `executePayment` — the fee and the ETA are the
 * two things they cannot find out any other way.
 */
export async function quoteDepositPayment(opts: {
  user: string;
  deposit: PayableDeposit;
  /** Defaults to ETH, which is also the gas token so a wallet always has some. */
  asset?: PayAsset;
  /** Defaults to Robinhood mainnet. */
  chain?: Chain;
}): Promise<PaymentQuote> {
  const chain = opts.chain ?? robinhoodChain;
  const asset = opts.asset ?? "ETH";
  const { deposit } = opts;

  // Relay routes to Robinhood mainnet but not the testnet — hide the entry
  // point on testnet rather than letting the user hit an opaque Relay 400.
  if (chain.testnet) {
    throw new Error("Relay does not route to Robinhood testnet — use mainnet to pay a deposit");
  }

  const rail = PAY_RAILS[`${deposit.network}:${deposit.pay_currency}`];
  if (!rail) {
    throw new Error(`Unsupported payout rail: ${deposit.network}/${deposit.pay_currency}`);
  }
  // The address stops accepting after this; a quote signed too late is a
  // transfer into a dead deposit.
  if (Date.parse(deposit.expires_at) <= Date.now()) {
    throw new Error("This deposit has expired — request a new one");
  }

  return fetchQuote({
    user: getAddress(opts.user),
    recipient: deposit.pay_address,
    originChainId: chain.id,
    originCurrency: spendCurrency(asset, chain),
    destinationChainId: rail.chainId,
    destinationCurrency: rail.currency,
    amount: parseUnits(deposit.pay_amount, rail.decimals).toString(),
    tradeType: "EXACT_OUTPUT",
  });
}

/** One Relay /quote call, mapped to PaymentQuote. Shared by deposits and swaps. */
async function fetchQuote(body: Record<string, unknown>): Promise<PaymentQuote> {
  const q = await relay<{
    steps: RelayStep[];
    fees: { relayer?: { amountUsd?: string } };
    details: {
      currencyIn: { amountFormatted: string; amountUsd: string; currency: { symbol: string } };
      currencyOut: { amountFormatted: string; amountUsd: string; currency: { symbol: string } };
      timeEstimate: number;
    };
  }>("/quote", body);

  const steps = q.steps ?? [];
  return {
    inFormatted: q.details.currencyIn.amountFormatted,
    inSymbol: q.details.currencyIn.currency.symbol,
    inUsd: q.details.currencyIn.amountUsd,
    outFormatted: q.details.currencyOut.amountFormatted,
    outSymbol: q.details.currencyOut.currency.symbol,
    outUsd: q.details.currencyOut.amountUsd,
    feeUsd: q.fees.relayer?.amountUsd ?? "0",
    etaSeconds: q.details.timeEstimate,
    txCount: steps.reduce((n, s) => n + (s.items?.length ?? 0), 0),
    steps,
    statusPath: steps.flatMap((s) => s.items ?? []).at(-1)?.check?.endpoint,
  };
}

/* ---------- swaps: Robinhood Chain -> anywhere Relay reaches ---------- */

export interface SwapTarget {
  /** "Solana · SOL" — shown in the picker. */
  label: string;
  chainId: number;
  /** Token address, Solana mint, or a native sentinel. */
  currency: string;
  sym: string;
  /** Recipient is base58, not 0x. */
  solana?: boolean;
}

/**
 * Where a swap can land. Every route here was quoted live against Relay
 * (2026-08-07) — including same-chain USDG<->ETH and native SOL, whose Relay
 * id is the system-program address, not a mint.
 */
export const SWAP_TARGETS: SwapTarget[] = [
  { label: "Robinhood · USDG", chainId: 4663, currency: USDG_MAINNET, sym: "USDG" },
  { label: "Robinhood · ETH", chainId: 4663, currency: NATIVE, sym: "ETH" },
  { label: "Solana · SOL", chainId: 792703809, currency: "11111111111111111111111111111111", sym: "SOL", solana: true },
  { label: "Solana · USDC", chainId: 792703809, currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", sym: "USDC", solana: true },
  { label: "Solana · USDT", chainId: 792703809, currency: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", sym: "USDT", solana: true },
  { label: "Base · ETH", chainId: 8453, currency: NATIVE, sym: "ETH" },
  { label: "Base · USDC", chainId: 8453, currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", sym: "USDC" },
  { label: "Ethereum · ETH", chainId: 1, currency: NATIVE, sym: "ETH" },
  { label: "Arbitrum · ETH", chainId: 42161, currency: NATIVE, sym: "ETH" },
];

/**
 * Quotes spending ETH/USDG on Robinhood Chain into any target above —
 * EXACT_INPUT: the user says what they spend, the quote says what arrives.
 * Execute with the same `executePayment` the deposit flow uses.
 */
export function quoteSwap(opts: {
  user: string;
  asset: PayAsset;
  /** Base units of the origin asset (wei for ETH, 6-dec for USDG). */
  amount: bigint;
  to: SwapTarget;
  recipient: string;
  chain?: Chain;
}): Promise<PaymentQuote> {
  const chain = opts.chain ?? robinhoodChain;
  if (chain.testnet) {
    throw new Error("Relay does not route to Robinhood testnet — swaps need mainnet");
  }
  const origin = spendCurrency(opts.asset, chain);
  if (opts.to.chainId === chain.id && opts.to.currency.toLowerCase() === origin.toLowerCase()) {
    throw new Error("That would swap an asset into itself — pick a different target");
  }
  return fetchQuote({
    user: getAddress(opts.user),
    recipient: opts.recipient,
    originChainId: chain.id,
    originCurrency: origin,
    destinationChainId: opts.to.chainId,
    destinationCurrency: opts.to.currency,
    amount: opts.amount.toString(),
    tradeType: "EXACT_INPUT",
  });
}

/** Terminal states from Relay's /intents/status. */
const DONE = new Set(["success", "failure", "refund"]);

async function waitForFill(path: string, onStage?: (s: string) => void): Promise<string> {
  // Relay quotes seconds; poll for two minutes before giving up. A timeout here
  // means "we stopped watching", not "the funds are lost" — the intent is
  // already on-chain, so say so rather than implying failure.
  for (let i = 0; i < 60; i++) {
    const { status } = await relay<{ status: string }>(path);
    if (DONE.has(status)) return status;
    if (i === 0) onStage?.("Waiting for the payment to land…");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("This is taking longer than expected — check back shortly");
}

/**
 * Signs every tx in the quote on Robinhood Chain and waits for the fill.
 * Resolves "success" when the provider's address has the money — that is the
 * point at which `applyDeposit` on the server side will find it credited.
 */
export async function executePayment(
  quote: PaymentQuote,
  wallet: WalletClient,
  opts?: { chain?: Chain; onStage?: (s: string) => void }
): Promise<string> {
  const chain = opts?.chain ?? robinhoodChain;
  const account = wallet.account;
  if (!account) throw new Error("Wallet not connected");

  // Reads go through the wallet's own provider, so no extra RPC host learns the
  // user's IP.
  const reader = createPublicClient({ chain, transport: custom({ request: wallet.request }) });
  await wallet.switchChain({ id: chain.id });

  const items = quote.steps.flatMap((s) => (s.items ?? []).map((item) => ({ step: s, item })));
  for (const { step, item } of items) {
    opts?.onStage?.(step.description ?? `Signing ${step.id}…`);
    const hash = await wallet.sendTransaction({
      account,
      chain,
      to: item.data.to,
      data: item.data.data,
      value: BigInt(item.data.value ?? "0"),
    });
    // The approve step carries no `check`, so the swap that follows would
    // revert if we did not wait for the allowance to land.
    await reader.waitForTransactionReceipt({ hash });
  }

  if (!quote.statusPath) return "success";
  return waitForFill(quote.statusPath, opts?.onStage);
}

/** Quote and pay in one call, for flows that do not show a confirmation step. */
export async function payDeposit(opts: {
  user: string;
  deposit: PayableDeposit;
  wallet: WalletClient;
  asset?: PayAsset;
  chain?: Chain;
  onStage?: (s: string) => void;
}): Promise<string> {
  const quote = await quoteDepositPayment(opts);
  return executePayment(quote, opts.wallet, { chain: opts.chain, onStage: opts.onStage });
}
