"use client";

// Retropay-style dashboard over the real card actions. Three views share one
// right column (the card itself + quick actions + cost overview), like the
// reference: sidebar nav, stat tiles, banner, activity log.
//
// Nothing here imports src/kripicard.ts — that module throws in a browser by
// design. Card actions go through /api/cards with a Privy token; only the
// on-chain leg (src/pay.ts) runs client-side, because only the browser has the
// wallet.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  createPublicClient,
  erc20Abi,
  formatEther,
  getAddress,
  http,
  parseEther,
  parseUnits,
} from "viem";
import { useExportWallet } from "@privy-io/react-auth";
import { useEvmWallet } from "./lib/wallet";
import { useAuthedFetch } from "./lib/authed-fetch";
import {
  executePayment,
  quoteDepositPayment,
  quoteSwap,
  robinhoodChain,
  SWAP_TARGETS,
  USDG_MAINNET,
  type PayAsset,
  type PaymentQuote,
} from "../src/pay";

/** Provider floor. Kept in sync by hand: the server constant lives in a module
 *  the browser must not load. */
const MIN_DEPOSIT = 10;

/** The one BIN this project issues on — Visa US, Apple/Samsung/Google Pay, no
 *  date of birth. The library takes any BIN; only this UI narrows. */
const CARD_BIN = "441357";

/** What the provider charges to issue: $5 issuance + $1 processing + 4% load. */
const issueCost = (load: number) => 5 + 1 + load * 0.04 + load;

const reader = createPublicClient({ chain: robinhoodChain, transport: http() });

interface Card {
  cardId: string;
  last4: string;
  bin: string;
  holder: string;
}
interface CardDetails {
  card_number: string;
  expiry: string;
  cvv: string;
  balance: number;
  status: string;
}
interface Tx {
  date: string;
  type: string;
  merchant: string;
  amount: number;
  currency: string;
  status: string;
}
interface Deposit {
  id: string;
  amount_usd: number;
  fee_usd: number;
  credited_on_completion_usd: number;
  pay_address: string;
  pay_amount: string;
  pay_currency: string;
  network: string;
  expires_at: string;
}
interface PendingDeposit {
  depositId: string;
  cardId: string | null;
  creditUsd: number;
}

type View = "dashboard" | "swap" | "cards" | "topup" | "history" | "settings";
const TITLES: Record<View, string> = {
  dashboard: "Assets",
  swap: "Swap",
  cards: "Cards",
  topup: "Top Up",
  history: "History",
  settings: "Settings",
};

type TF = "1D" | "1W" | "1M" | "ALL";

/** One row of combined history — a wallet transfer or a card charge. */
interface HEvent {
  ts: number;
  source: "wallet" | "card";
  label: string;
  sub: string;
  qty: number;
  /** "ETH" | "USDG" | "USD" (card) | anything else a token transfer carries. */
  sym: string;
  ok: boolean;
  dir: "in" | "out";
}

/* Blockscout v2 payloads, only the fields we read. */
interface BsNative {
  timestamp?: string;
  value?: string;
  from?: { hash?: string };
  to?: { hash?: string };
  status?: string;
  hash?: string;
}
interface BsToken {
  timestamp?: string;
  total?: { value?: string; decimals?: string };
  token?: { symbol?: string };
  from?: { hash?: string };
  transaction_hash?: string;
}

const TF_STEP: Record<TF, { step: number; count: number }> = {
  "1D": { step: 3_600_000, count: 24 },
  "1W": { step: 86_400_000, count: 7 },
  "1M": { step: 86_400_000, count: 30 },
  ALL: { step: 7 * 86_400_000, count: 26 }, // half a year of weeks; "all" beyond that is off-chart but still listed
};

/* Tiny stroke icons — one place, one style. */
const ic = {
  grid: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" />
    </svg>
  ),
  card: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="2.5" y="5" width="19" height="14" rx="3" /><path d="M2.5 10h19M6 15h4" />
    </svg>
  ),
  down: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v11M7.5 11.5 12 16l4.5-4.5M5 20h14" />
    </svg>
  ),
  clock: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
    </svg>
  ),
  wallet: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="3" y="6" width="18" height="13" rx="3" /><path d="M3 10h18M16.5 14.5h.01" />
    </svg>
  ),
  eye: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.6" />
    </svg>
  ),
  snow: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 2v20M3.3 7l17.4 10M20.7 7 3.3 17" />
    </svg>
  ),
  refresh: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.5 11.5a8.5 8.5 0 1 1-2.49-6.01M20.5 3.5V7H17" />
    </svg>
  ),
  out: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M15 8l4 4-4 4M19 12H9" />
    </svg>
  ),
  wave: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M6.5 9a6.5 6.5 0 0 1 0 6M10 6.5a10.5 10.5 0 0 1 0 11M13.5 4a15 15 0 0 1 0 16" />
    </svg>
  ),
  back: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 5h10A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-10L3 12l5.5-7Z" />
      <path d="m12 9.5 5 5m0-5-5 5" />
    </svg>
  ),
  send: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12 20 5l-6 16-2.5-6.5L4 12Z" />
      <path d="M11.5 14.5 20 5" />
    </svg>
  ),
  check: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  ),
  chart: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M5 20v-8M12 20V6M19 20v-4M3.5 20h17" />
    </svg>
  ),
  shield: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-2.5Z" />
    </svg>
  ),
  spark: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
    </svg>
  ),
  copy: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </svg>
  ),
  burger: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  ),
  swap: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h13m0 0-3.5-3.5M17 7l-3.5 3.5" />
      <path d="M20 17H7m0 0 3.5-3.5M7 17l3.5 3.5" />
    </svg>
  ),
  x: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  qr: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="4" y="4" width="6" height="6" rx="1.5" />
      <rect x="14" y="4" width="6" height="6" rx="1.5" />
      <rect x="4" y="14" width="6" height="6" rx="1.5" />
      <path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5z" />
    </svg>
  ),
  gear: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 7.5h16M4 12h16M4 16.5h16" />
      <circle cx="9.5" cy="7.5" r="1.8" fill="var(--panel, #fff)" />
      <circle cx="15" cy="12" r="1.8" fill="var(--panel, #fff)" />
      <circle cx="8" cy="16.5" r="1.8" fill="var(--panel, #fff)" />
    </svg>
  ),
};

/** Tiny coin badges — inline SVG, so the CSP's img-src 'self' stays intact. */
const COIN: Record<string, React.ReactNode> = {
  ETH: (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="10" fill="#627eea" />
      <path d="M10 3.2 6.2 10.1l3.8 2.3 3.8-2.3L10 3.2Z" fill="#fff" opacity=".9" />
      <path d="m6.2 11.3 3.8 5.5 3.8-5.5-3.8 2.2-3.8-2.2Z" fill="#fff" opacity=".72" />
    </svg>
  ),
  USDG: (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="10" fill="#1c1c1a" />
      <text x="10" y="14" textAnchor="middle" fontSize="11" fontWeight="700" fill="#ccff00">G</text>
    </svg>
  ),
  SOL: (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
      <defs>
        <linearGradient id="solg" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#00ffa3" />
          <stop offset="1" stopColor="#dc1fff" />
        </linearGradient>
      </defs>
      <circle cx="10" cy="10" r="10" fill="#141414" />
      <path
        d="M6.6 6h7.2l-1.4 1.6H5.2L6.6 6Zm0 6.4h7.2l-1.4 1.6H5.2l1.4-1.6Zm6-3.2H5.4l1.4 1.6h7.2l-1.4-1.6Z"
        fill="url(#solg)"
      />
    </svg>
  ),
  USDC: (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="10" fill="#2775ca" />
      <text x="10" y="14" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">$</text>
    </svg>
  ),
  USDT: (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="10" fill="#26a17b" />
      <text x="10" y="14" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">T</text>
    </svg>
  ),
};

/** Display currencies — tiny inline SVG flags (CSP allows no external images). */
const CURRENCIES = [
  {
    code: "USD",
    name: "US Dollar",
    flag: (
      <svg className="fflag" viewBox="0 0 20 14" aria-hidden>
        <rect width="20" height="14" fill="#c0392b" />
        <g fill="#fff">
          <rect y="2" width="20" height="1.4" /><rect y="4.8" width="20" height="1.4" />
          <rect y="7.6" width="20" height="1.4" /><rect y="10.4" width="20" height="1.4" />
        </g>
        <rect width="9" height="7" fill="#31479e" />
      </svg>
    ),
  },
  {
    code: "IDR",
    name: "Indonesian Rupiah",
    flag: (
      <svg className="fflag" viewBox="0 0 20 14" aria-hidden>
        <rect width="20" height="7" fill="#ce1126" />
        <rect y="7" width="20" height="7" fill="#fff" />
      </svg>
    ),
  },
  {
    code: "JPY",
    name: "Japanese Yen",
    flag: (
      <svg className="fflag" viewBox="0 0 20 14" aria-hidden>
        <rect width="20" height="14" fill="#fff" />
        <circle cx="10" cy="7" r="3.4" fill="#bc002d" />
      </svg>
    ),
  },
  {
    code: "EUR",
    name: "Euro",
    flag: (
      <svg className="fflag" viewBox="0 0 20 14" aria-hidden>
        <rect width="20" height="14" fill="#003399" />
        <g fill="#ffcc00">
          <circle cx="14" cy="7" r="0.8" /><circle cx="12.8" cy="9.8" r="0.8" />
          <circle cx="10" cy="11" r="0.8" /><circle cx="7.2" cy="9.8" r="0.8" />
          <circle cx="6" cy="7" r="0.8" /><circle cx="7.2" cy="4.2" r="0.8" />
          <circle cx="10" cy="3" r="0.8" /><circle cx="12.8" cy="4.2" r="0.8" />
        </g>
      </svg>
    ),
  },
  {
    code: "GBP",
    name: "British Pound",
    flag: (
      <svg className="fflag" viewBox="0 0 20 14" aria-hidden>
        <rect width="20" height="14" fill="#012169" />
        <path d="M0 0 20 14M20 0 0 14" stroke="#fff" strokeWidth="2.6" />
        <path d="M0 0 20 14M20 0 0 14" stroke="#c8102e" strokeWidth="1.1" />
        <path d="M10 0v14M0 7h20" stroke="#fff" strokeWidth="4.2" />
        <path d="M10 0v14M0 7h20" stroke="#c8102e" strokeWidth="2.2" />
      </svg>
    ),
  },
];

/** Animated empty state — a floating icon inside slow ripple rings. */
const Empty = ({ title, sub, icon }: { title: string; sub: string; icon?: React.ReactNode }) => (
  <div className="empty">
    <div className="emptyart" aria-hidden>
      <span className="ring" />
      <span className="ring" />
      <span className="core">{icon ?? ic.clock}</span>
    </div>
    <b>{title}</b>
    <p className="sub">{sub}</p>
  </div>
);

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const groupPan = (n: string) => n.replace(/\D/g, "").replace(/(.{4})/g, "$1 ").trim();

export default function Page() {
  const { ready, isConnected, address, walletClient, login, logout } = useEvmWallet();
  const { exportWallet } = useExportWallet();
  const authedFetch = useAuthedFetch();

  const [view, setView] = useState<View>("dashboard");
  const [cardTab, setCardTab] = useState<"my" | "create">("my");
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletEvents, setWalletEvents] = useState<HEvent[] | null>(null);
  const [tf, setTf] = useState<TF>("1W");

  // Swap (Relay, same rail as deposits — every target quoted live before shipping)
  const [swapAsset, setSwapAsset] = useState<PayAsset>("ETH");
  const [swapAmt, setSwapAmt] = useState("");
  const [swapTo, setSwapTo] = useState(0);
  const [swapRcpt, setSwapRcpt] = useState("");
  const [swapQuote, setSwapQuote] = useState<PaymentQuote | null>(null);
  /** Amount field denominated in USD instead of the token. */
  const [swapUsdMode, setSwapUsdMode] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const [pending, setPending] = useState<PendingDeposit[]>([]);
  const [selected, setSelected] = useState("");
  const [details, setDetails] = useState<CardDetails | null>(null);
  const [txs, setTxs] = useState<Tx[] | null>(null);
  const [deposit, setDeposit] = useState<Deposit | null>(null);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [asset, setAsset] = useState<PayAsset>("ETH");
  const [ethBal, setEthBal] = useState<string | null>(null);
  const [out, setOut] = useState<unknown>(null);
  const [stage, setStage] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const [nameOnCard, setNameOnCard] = useState("");
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState("10");
  const [topUp, setTopUp] = useState(String(MIN_DEPOSIT));
  /** Where the deposit lands once credited: straight onto a card, or account only. */
  const [fundTarget, setFundTarget] = useState<"card" | "account">("card");
  const [hideBal, setHideBal] = useState(false);

  // Wallet (Assets view): balances, price, send/receive.
  const [usdgBal, setUsdgBal] = useState<string | null>(null);
  const [ethPrice, setEthPrice] = useState<number | null>(null);
  const [walletAction, setWalletAction] = useState<"send" | "receive" | "scan" | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [scanErr, setScanErr] = useState("");

  // Display currency: aggregates convert; individual transactions and USD-
  // denominated business amounts (fees, quotes, card loads) stay as they are.
  const [cur, setCur] = useState("USD");
  const [fxRates, setFxRates] = useState<Record<string, number>>({ USD: 1 });
  const [curOpen, setCurOpen] = useState(false);
  const [sendAsset, setSendAsset] = useState<PayAsset>("ETH");
  const [sendTo, setSendTo] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [txHash, setTxHash] = useState("");
  const [copied, setCopied] = useState(false);

  const tapDigit = (d: string) =>
    setTopUp((v) => {
      if (d === ".") return v.includes(".") ? v : v + ".";
      if (/\.\d\d$/.test(v)) return v; // two decimal places is money's limit
      return v === "0" ? d : (v + d).slice(0, 7);
    });
  const tapBack = () => setTopUp((v) => v.slice(0, -1) || "0");

  const card = cards.find((c) => c.cardId === selected) ?? cards[0] ?? null;

  const run = useCallback(
    async <T,>(label: string, body: Record<string, unknown>): Promise<T | null> => {
      setBusy(label);
      setErr("");
      try {
        return await authedFetch<T>(body);
      } catch (e) {
        setErr((e as Error).message);
        return null;
      } finally {
        setBusy("");
      }
    },
    [authedFetch]
  );

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    const r = await run<{ cards: Card[]; deposits: PendingDeposit[] }>("list", { action: "list" });
    if (r) {
      setCards(r.cards);
      setPending(r.deposits);
    }
  }, [isConnected, run]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Balances straight off the chain — read-only, no provider quota spent.
  const refreshBalances = useCallback(() => {
    if (!address) return;
    const a = address as `0x${string}`;
    reader
      .getBalance({ address: a })
      .then((b) => setEthBal(Number(formatEther(b)).toFixed(4)))
      .catch(() => setEthBal(null));
    reader
      .readContract({ address: USDG_MAINNET, abi: erc20Abi, functionName: "balanceOf", args: [a] })
      .then((b) => setUsdgBal((Number(b) / 1e6).toFixed(2)))
      .catch(() => setUsdgBal(null));
  }, [address]);

  useEffect(refreshBalances, [refreshBalances]);

  // FX rate for the chosen display currency, via our own /api/fx proxy — a
  // same-origin call no ad-blocker or CSP can eat. Fails soft: no rate →
  // figures stay in USD rather than lying.
  useEffect(() => {
    if (cur === "USD" || fxRates[cur]) return;
    fetch(`/api/fx?to=${cur}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { rate?: number } | null) => {
        if (j?.rate) setFxRates((p) => ({ ...p, [cur]: j.rate! }));
        else setErr("Exchange rate unavailable — showing USD");
      })
      .catch(() => setErr("Exchange rate unavailable — showing USD"));
  }, [cur, fxRates]);

  /** USD → display currency, with the right symbol and decimals. */
  const fm = (usd: number): string => {
    const rate = fxRates[cur];
    if (!rate || cur === "USD") return `$${usd.toFixed(2)}`;
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cur,
      maximumFractionDigits: cur === "IDR" || cur === "JPY" ? 0 : 2,
    }).format(usd * rate);
  };

  // ETH price via a same-chain Relay quote (1 ETH → USDG) — the only price
  // source the CSP already allows. Fails soft: no price, no USD figures.
  useEffect(() => {
    if (!address) return;
    fetch("https://api.relay.link/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user: address,
        recipient: address,
        originChainId: robinhoodChain.id,
        destinationChainId: robinhoodChain.id,
        originCurrency: "0x0000000000000000000000000000000000000000",
        destinationCurrency: USDG_MAINNET,
        amount: "1000000000000000000",
        tradeType: "EXACT_INPUT",
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setEthPrice(Number(j?.details?.currencyIn?.amountUsd) || null))
      .catch(() => setEthPrice(null));
  }, [address]);

  /** Sends ETH or USDG out of the Privy wallet. Real money on mainnet. */
  const doSend = async () => {
    const account = walletClient?.account;
    if (!account) return;
    setBusy("send");
    setErr("");
    setTxHash("");
    try {
      const to = getAddress(sendTo.trim()); // throws on a malformed address
      const hash =
        sendAsset === "ETH"
          ? await walletClient.sendTransaction({
              account,
              chain: robinhoodChain,
              to,
              value: parseEther(sendAmt),
            })
          : await walletClient.writeContract({
              account,
              chain: robinhoodChain,
              address: USDG_MAINNET,
              abi: erc20Abi,
              functionName: "transfer",
              args: [to, parseUnits(sendAmt, 6)],
            });
      setTxHash(hash);
      setStage("Waiting for confirmation…");
      await reader.waitForTransactionReceipt({ hash });
      setStage("");
      setSendAmt("");
      refreshBalances();
    } catch (e) {
      setStage("");
      setErr((e as Error).message.split("\n")[0]);
    } finally {
      setBusy("");
    }
  };

  // Switching cards or views invalidates revealed credentials on screen,
  // and an open Send/Receive dialog doesn't survive leaving the view either.
  useEffect(() => {
    setDetails(null);
    setWalletAction(null);
  }, [selected, view]);

  // Esc dismisses the Send/Receive dialog.
  useEffect(() => {
    if (!walletAction) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setWalletAction(null);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [walletAction]);

  // QR scanning via the browser's own BarcodeDetector — no library, camera only
  // lives while the dialog is open, and a hit lands straight in the Send form.
  useEffect(() => {
    if (walletAction !== "scan") return;
    setScanErr("");
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const Detector = (
      window as unknown as {
        BarcodeDetector?: new (o: { formats: string[] }) => {
          detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]>;
        };
      }
    ).BarcodeDetector;
    if (!Detector) {
      setScanErr("This browser can't scan QR codes — use Chrome, or paste the address into Send.");
      return;
    }
    const detector = new Detector({ formats: ["qr_code"] });

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        stream = s;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = s;
        void v.play();
        timer = setInterval(async () => {
          const el = videoRef.current;
          if (!el || el.readyState < 2) return;
          try {
            const codes = await detector.detect(el);
            const hit = codes
              .map((c) => c.rawValue.match(/0x[0-9a-fA-F]{40}/)?.[0])
              .find(Boolean);
            if (hit) {
              setSendTo(hit);
              setWalletAction("send"); // cleanup below stops the camera
            }
          } catch {
            /* a frame that fails to decode is not an error */
          }
        }, 350);
      })
      .catch(() => setScanErr("Camera access was refused — allow it, or paste the address into Send."));

    return () => {
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [walletAction]);

  // Swap recipient defaults to the user's own address on EVM targets; a Solana
  // target clears it — an 0x address on Solana would burn the funds.
  useEffect(() => {
    const t = SWAP_TARGETS[swapTo];
    setSwapRcpt(t?.solana ? "" : (address ?? ""));
    setSwapQuote(null);
  }, [swapTo, address]);

  // My Card opens with its history already there — one load per card, then the
  // History button becomes a manual refresh (their rate limit is unforgiving).
  // Lives ABOVE the early returns: hooks must run on every render path.
  useEffect(() => {
    if ((view !== "cards" && view !== "history") || !card || txs !== null) return;
    void run<{ data?: { transactions?: Tx[] } }>("tx", {
      action: "transactions",
      cardId: card.cardId,
    }).then((r) => {
      if (r) setTxs(r.data?.transactions ?? []);
    });
  }, [view, card, txs, run]);

  // Wallet history off Blockscout — an RPC can't answer "what has this address
  // done", only the indexer can. Latest page of each kind; fails soft to [].
  useEffect(() => {
    if (view !== "history" || !address || walletEvents !== null) return;
    const a = address.toLowerCase();
    const base = `https://robinhoodchain.blockscout.com/api/v2/addresses/${address}`;
    const grab = (url: string) =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .catch(() => ({ items: [] }));
    void Promise.all([grab(`${base}/transactions`), grab(`${base}/token-transfers`)]).then(
      ([nat, tok]) => {
        const evts: HEvent[] = [];
        for (const t of ((nat.items ?? []) as BsNative[])) {
          const wei = Number(t.value ?? 0);
          if (!wei) continue; // value-less contract calls aren't money moves
          const out = t.from?.hash?.toLowerCase() === a;
          evts.push({
            ts: Date.parse(t.timestamp ?? "") || 0,
            source: "wallet",
            label: out ? "Sent ETH" : "Received ETH",
            sub: `${(t.hash ?? "").slice(0, 10)}…`,
            qty: wei / 1e18,
            sym: "ETH",
            ok: (t.status ?? "ok") === "ok",
            dir: out ? "out" : "in",
          });
        }
        for (const t of ((tok.items ?? []) as BsToken[])) {
          const dec = Number(t.total?.decimals ?? 18);
          const qty = Number(t.total?.value ?? 0) / 10 ** dec;
          if (!qty) continue;
          const sym = t.token?.symbol ?? "TOKEN";
          const out = t.from?.hash?.toLowerCase() === a;
          evts.push({
            ts: Date.parse(t.timestamp ?? "") || 0,
            source: "wallet",
            label: `${out ? "Sent" : "Received"} ${sym}`,
            sub: `${(t.transaction_hash ?? "").slice(0, 10)}…`,
            qty,
            sym,
            ok: true,
            dir: out ? "out" : "in",
          });
        }
        setWalletEvents(evts);
      }
    );
  }, [view, address, walletEvents]);

  if (!ready) {
    return (
      <div className="login">
        <p className="sub">Loading…</p>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="login">
        <div className="box stagger">
          <div className="visa" aria-hidden>
            <div className="top">
              <span className="chipsvg">
                <svg width="34" height="24" viewBox="0 0 34 24" fill="none">
                  <rect x="1" y="1" width="32" height="22" rx="5" stroke="#d8b45e" strokeWidth="1.5" />
                  <path d="M1 9h32M1 15h32M12 9v6M22 9v6" stroke="#d8b45e" strokeWidth="1.2" />
                </svg>
                {ic.wave}
              </span>
              <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--orange)", opacity: 0.85 }} />
            </div>
            <div className="name">Your Name</div>
            <div className="bottom">
              <span className="num">•••• •••• •••• ••••</span>
              <span className="brand">VISA</span>
            </div>
          </div>
          <div>
            <img src="/logo.png" alt="" className="logoimg" style={{ width: 52, height: 52, borderRadius: 14 }} />
            <h1 className="pagetitle" style={{ marginTop: ".5rem" }}>HoodBank</h1>
            <p className="sub" style={{ marginTop: ".4rem" }}>
              Wallet, swaps and Visa cards on Robinhood Chain. Sign in to get a wallet — your
              cards belong to its address.
            </p>
          </div>
          <button className="btn dark" onClick={login}>
            Sign in
          </button>
        </div>
      </div>
    );
  }

  const load = Number(amount) || 0;
  const fees = issueCost(load) - load;

  const quickAct = async (action: "details" | "transactions" | "freeze" | "unfreeze") => {
    if (!card) return;
    if (action === "details") {
      if (details) return setDetails(null);
      const r = await run<{ details: CardDetails }>("details", { action, cardId: card.cardId });
      if (r) setDetails(r.details);
      return;
    }
    if (action === "transactions") {
      const r = await run<{ data?: { transactions?: Tx[] } }>("tx", { action, cardId: card.cardId });
      if (r) setTxs(r.data?.transactions ?? []);
      return;
    }
    const r = await run(action, { action, cardId: card.cardId });
    if (r) setOut(r);
  };

  // Spending, from the real transactions: failed/declined rows don't count.
  const okTx = (txs ?? []).filter((t) => !/fail|declin|revers/i.test(t.status ?? ""));
  const spendTotal = okTx.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
  const spendByType = Object.entries(
    okTx.reduce<Record<string, number>>((m, t) => {
      const k = (t.type || "other").toLowerCase();
      m[k] = (m[k] ?? 0) + Math.abs(Number(t.amount) || 0);
      return m;
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  // Allocation for the Assets donut — USD shares, only when the price is known.
  const ethUsd = ethPrice && ethBal ? Number(ethBal) * ethPrice : 0;
  const usdgUsd = usdgBal ? Number(usdgBal) : 0;
  const allocTotal = ethUsd + usdgUsd;

  // ---- History: wallet + card merged onto one timeline ----
  /** USD value of an event, for the chart. Unpriceable events chart as nothing
   *  but still appear in the list — hiding them would be lying by omission. */
  const usdOf = (e: HEvent): number | null =>
    e.sym === "ETH" ? (ethPrice ? e.qty * ethPrice : null) : e.sym === "USDG" || e.sym === "USD" ? e.qty : null;

  const cardEvents: HEvent[] = (txs ?? []).map((t) => ({
    ts: Date.parse(t.date) || 0,
    source: "card" as const,
    label: t.merchant || t.type || "Card charge",
    sub: `card •••• ${card?.last4 ?? ""}`,
    qty: Math.abs(Number(t.amount) || 0),
    sym: "USD",
    ok: !/fail|declin/i.test(t.status ?? ""),
    dir: "out" as const,
  }));
  const allEvents = [...(walletEvents ?? []), ...cardEvents].sort((a, b) => b.ts - a.ts);

  const { step, count } = TF_STEP[tf];
  const rangeStart = Date.now() - step * count;
  const inRange = allEvents.filter((e) => e.ts >= rangeStart);
  const cols = Array.from({ length: count }, (_, i) => ({ t: rangeStart + i * step, wallet: 0, card: 0 }));
  for (const e of inRange) {
    const usd = usdOf(e);
    if (usd == null) continue;
    cols[Math.min(count - 1, Math.floor((e.ts - rangeStart) / step))][e.source] += usd;
  }
  const histMax = Math.max(...cols.map((c) => c.wallet + c.card), 1);
  const histTotal = cols.reduce((s, c) => s + c.wallet + c.card, 0);
  const tfLabel = (t: number) =>
    tf === "1D"
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });

  return (
    <div className={walletAction ? "shell blurred" : "shell"}>
      {/* mobile: dim + close target behind the open drawer */}
      {menuOpen && (
        <button className="scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />
      )}

      {/* ---------- sidebar (a drawer on mobile) ---------- */}
      <aside className={`side panel ${menuOpen ? "open" : ""}`}>
        <div className="logo">
          <img src="/logo.png" alt="" className="logoimg" />
          <b>HoodBank</b>
        </div>
        <div className="welcome">
          Welcome back <span aria-hidden>:)</span>
          <small>{short(address!)} · Robinhood Chain</small>
        </div>

        <nav className="nav">
          {(
            [
              ["dashboard", "Assets", ic.wallet],
              ["swap", "Swap", ic.swap],
              ["cards", "Cards", ic.card],
              ["topup", "Top Up", ic.down],
              ["history", "History", ic.clock],
              ["settings", "Settings", ic.gear],
            ] as const
          ).map(([v, label, icon]) => (
            <button
              key={v}
              className={view === v ? "on" : ""}
              onClick={() => {
                setView(v);
                setMenuOpen(false); // picking a destination dismisses the drawer
              }}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebal">
          <div className="amt">{hideBal ? "••••" : `${ethBal ?? "—"} ETH`}</div>
          <div className="lbl">
            Wallet Balance{" "}
            <button
              className="linkbtn"
              onClick={() => setHideBal(!hideBal)}
              aria-label={hideBal ? "Show balance" : "Hide balance"}
            >
              {ic.eye}
            </button>
          </div>
        </div>

        <div className="identity">
          <span className="avatar" aria-hidden />
          <div className="who">
            {card?.holder || "No card yet"}
            <small>{address}</small>
          </div>
          <button className="icobtn" onClick={logout} title="Sign out" style={{ marginLeft: "auto", flexShrink: 0 }}>
            {ic.out}
          </button>
        </div>
      </aside>

      {/* ---------- main ---------- */}
      <div className="mainwrap">
        <header className="mainhead">
          <div style={{ display: "flex", alignItems: "center", gap: ".7rem" }}>
            <button
              className="icobtn burger"
              aria-label="Open menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              {ic.burger}
            </button>
            <h1 className="pagetitle">{TITLES[view]}</h1>
          </div>
          <div className="acts">
            {/* display-currency picker */}
            <div style={{ position: "relative" }}>
              <button
                className="icobtn"
                style={{ width: "auto", padding: "0 .65rem", gap: ".4rem" }}
                aria-haspopup="listbox"
                aria-expanded={curOpen}
                title="Display currency"
                onClick={() => setCurOpen(!curOpen)}
              >
                {CURRENCIES.find((c) => c.code === cur)?.flag}
                <b style={{ fontSize: ".78rem" }}>{cur}</b>
              </button>
              {curOpen && (
                <>
                  <button className="popscrim" aria-label="Close" onClick={() => setCurOpen(false)} />
                  <div className="curpop" role="listbox" aria-label="Display currency">
                    {CURRENCIES.map((c) => (
                      <button
                        key={c.code}
                        className={cur === c.code ? "on" : ""}
                        role="option"
                        aria-selected={cur === c.code}
                        onClick={() => {
                          setErr("");
                          setCur(c.code);
                          // New object identity re-arms the fetch effect, so a
                          // previously failed rate gets retried on re-pick.
                          setFxRates((p) => ({ ...p }));
                          setCurOpen(false);
                        }}
                      >
                        {c.flag}
                        <span className="cname">
                          <b>{c.code}</b>
                          <small>{c.name}</small>
                        </span>
                        {cur === c.code && ic.check}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              className="icobtn"
              title="Refresh"
              disabled={!!busy}
              onClick={() => {
                void refresh();
                refreshBalances();
                if (view === "history") {
                  setWalletEvents(null);
                  setTxs(null);
                }
              }}
            >
              {ic.refresh}
            </button>
          </div>
        </header>

        {err && <div className="notice err">{err}</div>}
        {stage && <div className="notice info">{stage}</div>}

        {/* One column everywhere — the card moved into the Cards view's own tabs. */}
        <div className="cols solo">
          <div className="viewpane" key={view}>
            {/* ============ ASSETS — wallet home ============ */}
            {view === "dashboard" && (
              <div className="mycols">
                <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem", minWidth: 0 }}>
                <section className="panel rh stagger">
                  <p className="sub">Total portfolio</p>
                  <div
                    className="serif"
                    style={{ fontSize: "2.6rem", lineHeight: 1.1, letterSpacing: "-0.01em", margin: ".55rem 0" }}
                  >
                    {hideBal
                      ? "••••"
                      : ethPrice && ethBal && usdgBal
                        ? fm(Number(ethBal) * ethPrice + Number(usdgBal))
                        : `${ethBal ?? "—"} ETH`}
                  </div>
                  <p className="sub" style={{ marginTop: ".55rem", marginBottom: ".35rem" }}>
                    Robinhood Chain · {short(address!)}
                    {pending.length > 0 && ` · ${pending.length} deposit pending`}
                  </p>
                  <div className="quick">
                    <button
                      onClick={() => setWalletAction(walletAction === "send" ? null : "send")}
                      className={walletAction === "send" ? "on" : ""}
                    >
                      {ic.send}
                      Send
                    </button>
                    <button
                      onClick={() => setWalletAction(walletAction === "receive" ? null : "receive")}
                    >
                      {ic.down}
                      Receive
                    </button>
                    <button onClick={() => setWalletAction("scan")}>
                      {ic.qr}
                      Scan
                    </button>
                    <button onClick={() => setView("topup")}>
                      {ic.wallet}
                      Top Up
                    </button>
                  </div>
                </section>

                {/* Portaled to <body>: the animated view wrapper carries a
                    transform, which would trap position:fixed inside it and
                    clip the veil to the main column. */}
                {walletAction === "send" &&
                  createPortal(
                  <div
                    className="modalscrim"
                    onClick={(e) => {
                      if (e.target === e.currentTarget) setWalletAction(null);
                    }}
                  >
                  <section className="panel modal" role="dialog" aria-modal="true" aria-label="Send">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <h4 className="ph phrow">{ic.send}Send</h4>
                      <button className="icobtn" aria-label="Close" onClick={() => setWalletAction(null)}>
                        {ic.x}
                      </button>
                    </div>
                    <div className="seg" style={{ margin: ".7rem 0" }}>
                      {(["ETH", "USDG"] as const).map((a) => (
                        <button key={a} className={sendAsset === a ? "on" : ""} onClick={() => setSendAsset(a)}>
                          {COIN[a]}
                          {a}
                        </button>
                      ))}
                    </div>
                    <div className="row">
                      <div style={{ flex: "2 1 14rem" }}>
                        <label htmlFor="sto">Recipient address</label>
                        <input
                          id="sto"
                          value={sendTo}
                          placeholder="0x…"
                          onChange={(e) => setSendTo(e.target.value)}
                        />
                      </div>
                      <div>
                        <label htmlFor="samt">Amount ({sendAsset})</label>
                        <input
                          id="samt"
                          value={sendAmt}
                          placeholder="0.01"
                          onChange={(e) => setSendAmt(e.target.value)}
                        />
                      </div>
                    </div>
                    <p className="sub" style={{ margin: ".45rem 0 0", fontSize: ".78rem" }}>
                      Balance: {sendAsset === "ETH" ? `${ethBal ?? "—"} ETH` : `${usdgBal ?? "—"} USDG`}.
                      Mainnet — this moves real funds and cannot be undone.
                    </p>
                    <button
                      className="btn dark sendbtn"
                      style={{ marginTop: ".8rem" }}
                      disabled={
                        !!busy || !/^0x[0-9a-fA-F]{40}$/.test(sendTo.trim()) || !(Number(sendAmt) > 0)
                      }
                      onClick={doSend}
                    >
                      {ic.send}
                      {busy === "send" ? "Sending…" : `Send ${sendAmt || "0"} ${sendAsset}`}
                    </button>
                    {txHash && (
                      <p className="sub" style={{ marginTop: ".5rem", fontSize: ".78rem" }}>
                        Sent —{" "}
                        <a
                          href={`${robinhoodChain.blockExplorers!.default.url}/tx/${txHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          view on Blockscout ↗
                        </a>
                      </p>
                    )}
                  </section>
                  </div>,
                  document.body
                )}

                {walletAction === "scan" &&
                  createPortal(
                  <div
                    className="modalscrim"
                    onClick={(e) => {
                      if (e.target === e.currentTarget) setWalletAction(null);
                    }}
                  >
                  <section className="panel modal" role="dialog" aria-modal="true" aria-label="Scan QR">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <h4 className="ph phrow">{ic.qr}Scan QR</h4>
                      <button className="icobtn" aria-label="Close" onClick={() => setWalletAction(null)}>
                        {ic.x}
                      </button>
                    </div>
                    <p className="sub" style={{ margin: ".3rem 0 .7rem" }}>
                      Point the camera at a wallet QR — the address drops straight into Send.
                    </p>
                    {scanErr ? (
                      <div className="notice err">{scanErr}</div>
                    ) : (
                      <div className="scanbox">
                        <video ref={videoRef} muted playsInline />
                      </div>
                    )}
                  </section>
                  </div>,
                  document.body
                )}

                {walletAction === "receive" &&
                  createPortal(
                  <div
                    className="modalscrim"
                    onClick={(e) => {
                      if (e.target === e.currentTarget) setWalletAction(null);
                    }}
                  >
                  <section className="panel modal" role="dialog" aria-modal="true" aria-label="Receive">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <h4 className="ph phrow">{ic.down}Receive</h4>
                      <button className="icobtn" aria-label="Close" onClick={() => setWalletAction(null)}>
                        {ic.x}
                      </button>
                    </div>
                    <p className="sub" style={{ margin: ".3rem 0 0" }}>
                      Scan or copy — send only on <b>Robinhood Chain</b>. Assets from other
                      networks will not arrive here.
                    </p>

                    {/* QR with the chain logo excavated into the middle */}
                    <div className="qrwrap">
                      <QRCodeSVG
                        value={address!}
                        size={172}
                        bgColor="#ffffff"
                        fgColor="#211f1a"
                        level="H"
                        imageSettings={{ src: "/chains/robinhood.png", height: 32, width: 32, excavate: true }}
                      />
                    </div>

                    {/* copy lives inside the field */}
                    <div className="addrfield">
                      <code>{address}</code>
                      <button
                        className="icobtn"
                        aria-label="Copy address"
                        onClick={() => {
                          navigator.clipboard.writeText(address!);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        }}
                      >
                        {copied ? ic.check : ic.copy}
                      </button>
                    </div>
                    {copied && (
                      <p className="sub" style={{ margin: ".3rem 0 0", fontSize: ".75rem", color: "var(--green)" }}>
                        Copied to clipboard
                      </p>
                    )}

                    <div className="metarows" style={{ marginTop: ".6rem" }}>
                      <div className="kv">
                        <span>Network</span>
                        <b style={{ display: "inline-flex", alignItems: "center", gap: ".35rem" }}>
                          <img src="/chains/robinhood.png" alt="" className="cimg" /> Robinhood Chain
                        </b>
                      </div>
                      <div className="kv"><span>Chain ID</span><b>{robinhoodChain.id}</b></div>
                      <div className="kv"><span>Gas token</span><b>ETH</b></div>
                      <div className="kv"><span>Accepts</span><b>ETH · USDG</b></div>
                      <div className="kv">
                        <span>Explorer</span>
                        <b>
                          <a
                            href={`${robinhoodChain.blockExplorers!.default.url}/address/${address}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Blockscout ↗
                          </a>
                        </b>
                      </div>
                    </div>
                  </section>
                  </div>,
                  document.body
                )}

                <section className="panel">
                  <h4 className="ph phrow">{ic.wallet}Assets</h4>
                  <div className="rowitem">
                    <span className="chip c1">{COIN.ETH}</span>
                    <div className="meta">
                      <b>Ethereum</b>
                      <small>ETH · gas token</small>
                    </div>
                    <span className="amt">
                      {hideBal ? "••••" : `${ethBal ?? "—"} ETH`}
                      {!hideBal && ethPrice && ethBal && (
                        <small style={{ color: "var(--muted)", marginLeft: ".45rem" }}>
                          {fm(ethUsd)}
                        </small>
                      )}
                    </span>
                  </div>
                  <div className="rowitem">
                    <span className="chip c4">{COIN.USDG}</span>
                    <div className="meta">
                      <b>Global Dollar</b>
                      <small>USDG · stablecoin</small>
                    </div>
                    <span className="amt">
                      {hideBal ? "••••" : `${usdgBal ?? "—"} USDG`}
                      {!hideBal && usdgBal && (
                        <small style={{ color: "var(--muted)", marginLeft: ".45rem" }}>
                          {fm(usdgUsd)}
                        </small>
                      )}
                    </span>
                  </div>
                </section>

                {/* promo banner — clicks through to the card flow */}
                <button className="imgbanner" onClick={() => setView("cards")} aria-label="Open Cards">
                  <img
                    src="/banners/promo.png"
                    alt="Pay anything, anywhere, just one tap — the first utility card payment on Robinhood Chain using USDG"
                  />
                </button>
                </div>

                {/* right column: the log runs tall, like Card History on Cards */}
                <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
                <section className="panel" style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <h4 className="ph phrow">{ic.clock}Activity Log</h4>
                    {card && (
                      <button className="btn" disabled={!!busy} onClick={() => quickAct("transactions")}>
                        {busy === "tx" ? "Loading…" : `Load •••• ${card.last4}`}
                      </button>
                    )}
                  </div>
                  <p className="sub" style={{ marginBottom: ".4rem" }}>
                    Deposits in flight and card spending.
                  </p>

                  {pending.map((p) => (
                    <div className="rowitem" key={p.depositId}>
                      <span className="chip">{ic.clock}</span>
                      <div className="meta">
                        <b>Deposit {p.depositId}</b>
                        <small>{p.cardId ? `funds card ${p.cardId}` : "credits the account"}</small>
                      </div>
                      <span className="amt">
                        <span className="dot o" />${p.creditUsd.toFixed(2)}
                      </span>
                      <button
                        className="btn"
                        disabled={!!busy}
                        onClick={async () => {
                          const r = await run("apply", { action: "apply-deposit", depositId: p.depositId });
                          if (r) {
                            setOut(r);
                            await refresh();
                          }
                        }}
                      >
                        Apply
                      </button>
                    </div>
                  ))}

                  {txs?.map((t, i) => (
                    <div className="rowitem" key={i}>
                      <span className="chip">{ic.card}</span>
                      <div className="meta">
                        <b>{t.merchant || t.type}</b>
                        <small>{t.date}</small>
                      </div>
                      <span className="amt">
                        <span className={`dot ${t.status?.toLowerCase().includes("fail") ? "r" : "g"}`} />
                        ${t.amount} {t.currency}
                      </span>
                    </div>
                  ))}
                  {txs?.length === 0 && <p className="sub">No transactions on this card yet.</p>}
                  {!txs && pending.length === 0 && (
                    <Empty
                      title="No activity yet"
                      sub="Deposits in flight and card spending will show up here."
                    />
                  )}
                </section>

                <section className="panel">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <h4 className="ph phrow">{ic.chart}Allocation</h4>
                    <b className="serif" style={{ fontSize: "1.15rem" }}>
                      {hideBal ? "••••" : fm(allocTotal)}
                    </b>
                  </div>
                  <p className="sub">How the portfolio splits.</p>
                  <div className="bar" aria-hidden>
                    {allocTotal > 0 ? (
                      <>
                        {ethUsd > 0 && (
                          <span style={{ background: "#3b6fb5", flexGrow: Math.max(ethUsd, 0.1) }} />
                        )}
                        {usdgUsd > 0 && (
                          <span style={{ background: "#6c8a27", flexGrow: Math.max(usdgUsd, 0.1) }} />
                        )}
                      </>
                    ) : (
                      <span className="seg0" style={{ flexGrow: 1 }} />
                    )}
                  </div>
                  <div className="hlegend">
                    <span className="pair">
                      <i className="adot" style={{ background: "#3b6fb5" }} />
                      <span>ETH</span>
                      <b>{hideBal ? "••••" : fm(ethUsd)}</b>
                    </span>
                    <span className="pair">
                      <i className="adot" style={{ background: "#6c8a27" }} />
                      <span>USDG</span>
                      <b>{hideBal ? "••••" : fm(usdgUsd)}</b>
                    </span>
                  </div>
                </section>
                </div>
              </div>
            )}

            {/* ============ CARDS — My Card / Create Card ============ */}
            {view === "cards" && (
              <>
                <div>
                  <div className="crumb">/ Cards</div>
                  <h2 className="issuetitle">
                    {cardTab === "my" ? <>My <em>Card.</em></> : <>Create Virtual <em>Card.</em></>}
                  </h2>
                  <p className="sub">
                    {cardTab === "my"
                      ? "The card tied to this wallet — reveal it, freeze it, check its history."
                      : "Instantly issue a card funded from the account balance — no waiting period."}
                  </p>
                  <div className="slidetab" data-tab={cardTab} style={{ marginTop: ".9rem" }}>
                    <button className={cardTab === "my" ? "on" : ""} onClick={() => setCardTab("my")}>
                      My Card
                    </button>
                    <button className={cardTab === "create" ? "on" : ""} onClick={() => setCardTab("create")}>
                      Create Card
                    </button>
                  </div>
                </div>

                {cardTab === "my" && (
                  <div className="mycols viewpane" key="my">
                  <div className="mycard">
                    {card ? (
                      <div>
                        <div className="visa">
                          <div className="top">
                            <span className="chipsvg">
                              <svg width="34" height="24" viewBox="0 0 34 24" fill="none">
                                <rect x="1" y="1" width="32" height="22" rx="5" stroke="#d8b45e" strokeWidth="1.5" />
                                <path d="M1 9h32M1 15h32M12 9v6M22 9v6" stroke="#d8b45e" strokeWidth="1.2" />
                              </svg>
                              {ic.wave}
                            </span>
                            <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--orange)", opacity: 0.85 }} />
                          </div>
                          <div className="name">{card.holder}</div>
                          <div className="bottom">
                            <span className="num">
                              {details ? groupPan(details.card_number) : `•••• •••• •••• ${card.last4 || "••••"}`}
                            </span>
                            <span className="brand">VISA</span>
                          </div>
                        </div>
                        {cards.length > 1 && (
                          <div className="carddots">
                            {cards.map((c) => (
                              <button
                                key={c.cardId}
                                className={c.cardId === card.cardId ? "on" : ""}
                                onClick={() => setSelected(c.cardId)}
                                aria-label={`Card ${c.last4}`}
                              />
                            ))}
                          </div>
                        )}
                        {details && (
                          <div className="cred panel" style={{ padding: ".7rem .9rem" }}>
                            <div className="kv"><span>Number</span><code>{groupPan(details.card_number)}</code></div>
                            <div className="kv"><span>Expiry</span><code>{details.expiry}</code></div>
                            <div className="kv"><span>CVV</span><code>{details.cvv}</code></div>
                            <div className="kv"><span>Balance</span><code>${details.balance}</code></div>
                            <div className="kv"><span>Status</span><code>{details.status}</code></div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="ghostcard">
                        <div style={{ display: "grid", gap: ".7rem", justifyItems: "center" }}>
                          <span>No card yet.</span>
                          <button className="btn dark" onClick={() => setCardTab("create")}>
                            {ic.card}
                            Create your first card
                          </button>
                        </div>
                      </div>
                    )}

                    <section className="panel rh">
                      <h4 className="ph phrow">{ic.spark}Quick Actions</h4>
                      <p className="sub">For the card shown above.</p>
                      <div className="quick">
                        <button disabled={!card || !!busy} onClick={() => quickAct("details")}>
                          {ic.eye}
                          {details ? "Hide" : "Reveal"}
                        </button>
                        <button disabled={!card || !!busy} onClick={() => quickAct("transactions")}>
                          {ic.clock}
                          History
                        </button>
                        <button disabled={!card || !!busy} onClick={() => quickAct("freeze")}>
                          {ic.snow}
                          Freeze
                        </button>
                        <button disabled={!card || !!busy} onClick={() => quickAct("unfreeze")}>
                          {ic.card}
                          Unfreeze
                        </button>
                      </div>
                    </section>

                  </div>

                  {/* right side: what the card has been doing */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
                    <section className="panel">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
                        <div>
                          <h4 className="ph phrow">{ic.chart}Activity Overview</h4>
                          <p className="sub" style={{ margin: ".2rem 0 0" }}>
                            {!card
                              ? "No card yet — activity shows up once one exists."
                              : txs === null
                                ? "Loading history…"
                                : `${okTx.length} total transaction${okTx.length === 1 ? "" : "s"} on this card`}
                          </p>
                        </div>
                        <b className="serif" style={{ fontSize: "1.55rem", whiteSpace: "nowrap" }}>
                          {fm(spendTotal)}
                        </b>
                      </div>
                      {/* the chart field is always there — empty and grey until spending exists */}
                      <div className="bar" aria-hidden>
                        {spendByType.length > 0 ? (
                          spendByType.map(([k, v], i) => (
                            <span key={k} className={`seg${i + 1}`} style={{ flexGrow: Math.max(v, 0.1) }} />
                          ))
                        ) : (
                          <span className="seg0" style={{ flexGrow: 1 }} />
                        )}
                      </div>
                      <div className="hlegend">
                        {(spendByType.length > 0
                          ? spendByType
                          : ([["purchases", 0], ["refunds", 0], ["fees", 0]] as [string, number][])
                        ).map(([k, v]) => (
                          <span className="pair" key={k}>
                            <span style={{ textTransform: "capitalize" }}>{k}</span>
                            <b>{fm(v)}</b>
                          </span>
                        ))}
                      </div>
                    </section>

                    {/* flex: 1 — stretches so its bottom edge meets Quick Actions' */}
                    <section className="panel" style={{ flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <h4 className="ph phrow">{ic.clock}Card History</h4>
                        <button
                          className="btn"
                          disabled={!card || !!busy}
                          onClick={() => {
                            setTxs(null); // triggers the auto-load effect again
                          }}
                        >
                          {busy === "tx" ? "Loading…" : "Refresh"}
                        </button>
                      </div>
                      {(txs ?? []).map((t, i) => (
                        <div className="rowitem" key={i}>
                          <span className="chip">{ic.card}</span>
                          <div className="meta">
                            <b>{t.merchant || t.type}</b>
                            <small>{t.date}</small>
                          </div>
                          <span className="amt">
                            <span className={`dot ${t.status?.toLowerCase().includes("fail") ? "r" : "g"}`} />
                            ${t.amount} {t.currency}
                          </span>
                        </div>
                      ))}
                      {txs?.length === 0 && (
                        <Empty
                          icon={ic.card}
                          title="No transactions yet"
                          sub="Spending on this card will appear here."
                        />
                      )}
                      {txs === null &&
                        (card ? (
                          <p className="sub">Loading…</p>
                        ) : (
                          <Empty
                            icon={ic.card}
                            title="No card yet"
                            sub="Create one from the Create Card tab."
                          />
                        ))}
                    </section>
                  </div>
                  </div>
                )}

                {cardTab === "create" && (
                <div className="issue viewpane" key="create">
                  {/* ---- form ---- */}
                  <section className="panel" style={{ display: "flex", flexDirection: "column", gap: ".95rem" }}>
                    <div>
                      <label htmlFor="non">Name on card</label>
                      <input
                        id="non"
                        value={nameOnCard}
                        placeholder="e.g. Alex Morgan"
                        onChange={(e) => setNameOnCard(e.target.value)}
                      />
                    </div>

                    <div>
                      <label>Card type · BIN</label>
                      <div className="binrow">
                        <span className="flag" aria-hidden />
                        <b style={{ fontSize: ".88rem" }}>Visa — United States</b>
                        <span className="badge">ApplePay</span>
                        <span className="badge">SamsungPay</span>
                        <span className="badge">GooglePay</span>
                        <span className="sub" style={{ fontSize: ".72rem" }}>BIN {CARD_BIN}</span>
                        <span className="visablue">VISA</span>
                      </div>
                    </div>

                    <div>
                      <div className="flabel">
                        <label htmlFor="mail">Email</label>
                        <span className="hint">notifications &amp; receipts — optional</span>
                      </div>
                      <input
                        id="mail"
                        type="email"
                        value={email}
                        placeholder="you@example.com"
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>

                    <div>
                      <div className="flabel">
                        <label htmlFor="amt">Initial amount</label>
                        <span className="hint">USD · min $10</span>
                      </div>
                      <div className="amountwrap">
                        <b>$</b>
                        <input id="amt" value={amount} onChange={(e) => setAmount(e.target.value)} />
                      </div>
                      <div className="amtchips">
                        {["10", "25", "50", "100", "250"].map((v) => (
                          <button key={v} className={amount === v ? "on" : ""} onClick={() => setAmount(v)}>
                            ${v}
                          </button>
                        ))}
                      </div>
                    </div>

                    <table>
                      <tbody>
                        <tr><th>Card Amount</th><td>${load.toFixed(2)}</td></tr>
                        <tr><th>Issuance Fee</th><td>$5.00</td></tr>
                        <tr><th>Funding Fee (4%)</th><td>${(load * 0.04).toFixed(2)}</td></tr>
                        <tr><th>Processing Fee</th><td>$1.00</td></tr>
                        <tr>
                          <th><b style={{ color: "var(--ink)" }}>Total Cost</b></th>
                          <td>
                            <b className="serif" style={{ fontSize: "1.1rem", color: "var(--green)" }}>
                              ${issueCost(load).toFixed(2)}
                            </b>
                          </td>
                        </tr>
                      </tbody>
                    </table>

                    <button
                      className="btn dark sendbtn"
                      disabled={!!busy || !nameOnCard}
                      onClick={async () => {
                        const r = await run<{ card: unknown }>("create", {
                          action: "create",
                          bin: CARD_BIN,
                          amount: load,
                          nameOnCard,
                          email: email.trim() || undefined,
                        });
                        if (r) {
                          setOut(r.card);
                          await refresh();
                        }
                      }}
                    >
                      {ic.card}
                      {busy === "create" ? "Issuing…" : "Create card instantly"}
                    </button>
                    <p className="foot">
                      Issuing is irreversible and spends real money — ${fees.toFixed(2)} of the
                      total is fees. Closing a card later refunds the balance minus $2.
                    </p>
                  </section>

                  {/* ---- live preview ---- */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
                    <div>
                      <div className="prevhead">
                        <span>/ Live preview</span>
                        <span className="sync">Synced</span>
                      </div>
                      <div className="visa">
                        <div className="top">
                          <span className="chipsvg">
                            <svg width="34" height="24" viewBox="0 0 34 24" fill="none">
                              <rect x="1" y="1" width="32" height="22" rx="5" stroke="#d8b45e" strokeWidth="1.5" />
                              <path d="M1 9h32M1 15h32M12 9v6M22 9v6" stroke="#d8b45e" strokeWidth="1.2" />
                            </svg>
                            {ic.wave}
                          </span>
                          <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--orange)", opacity: 0.85 }} />
                        </div>
                        <div>
                          <div className="num">4413 57•• •••• ••••</div>
                          <div className="virtline">Virtual · issued on create</div>
                        </div>
                        <div className="minirow">
                          <div>
                            <small>Cardholder</small>
                            <b>{nameOnCard || "Your Name"}</b>
                          </div>
                          <div>
                            <small>Expires</small>
                            <b>––/––</b>
                          </div>
                          <div>
                            <small>CVV</small>
                            <b>•••</b>
                          </div>
                          <span className="brand" style={{ fontWeight: 800, fontStyle: "italic", fontSize: "1.1rem" }}>
                            VISA
                          </span>
                        </div>
                      </div>
                    </div>

                    <section className="panel">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <h4 className="ph phrow">{ic.shield}Visa — United States</h4>
                        <span className="crumb">● ApplePay</span>
                      </div>
                      <p className="sub" style={{ marginTop: ".3rem" }}>
                        Wide worldwide acceptance with Apple Pay, Samsung Pay and Google Pay
                        support. Provider note: manual approval.
                      </p>
                      <div className="specgrid">
                        <div className="spec"><small>Security</small><b>3DS + independent PIN</b></div>
                        <div className="spec"><small>Annual limit</small><b>$150,000</b></div>
                        <div className="spec"><small>Validity</small><b>3 years</b></div>
                        <div className="spec"><small>Top-ups</small><b>Unlimited</b></div>
                      </div>
                    </section>

                    <section className="panel">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <h4 className="ph phrow">{ic.chart}Cost Overview</h4>
                        <b className="serif" style={{ fontSize: "1.15rem" }}>${issueCost(load).toFixed(2)}</b>
                      </div>
                      <p className="sub">Issuing with a ${load.toFixed(2)} load.</p>
                      <div className="bar" aria-hidden>
                        <span className="seg1" style={{ flexGrow: load }} />
                        <span className="seg2" style={{ flexGrow: 5 }} />
                        <span className="seg3" style={{ flexGrow: 1 }} />
                        <span className="seg4" style={{ flexGrow: Math.max(load * 0.04, 0.2) }} />
                      </div>
                      <div className="legend">
                        <div className="kv"><i className="seg1" /><span>Spendable load</span>${load.toFixed(2)}</div>
                        <div className="kv"><i className="seg2" /><span>Issuance</span>$5.00</div>
                        <div className="kv"><i className="seg3" /><span>Processing</span>$1.00</div>
                        <div className="kv"><i className="seg4" /><span>Funding 4%</span>${(load * 0.04).toFixed(2)}</div>
                      </div>
                    </section>

                    <section className="panel">
                      <div className="prevhead" style={{ marginBottom: ".6rem" }}>
                        <span>/ Applicable platforms</span>
                        <span>+40 more</span>
                      </div>
                      <div className="platforms">
                        {["Facebook", "TikTok", "Google Pay", "Amazon", "OpenAI", "X", "Shopify", "Netflix"].map((p) => (
                          <span key={p}>{p}</span>
                        ))}
                      </div>
                    </section>
                  </div>
                </div>
                )}
              </>
            )}

            {/* ============ TOP UP ============ */}
            {view === "topup" && (
              <>
                <section className="panel composer">
                  <div className="inner">
                    {/* where the money lands */}
                    <div className="target">
                      <span className="pill">
                        <i aria-hidden />
                        {fundTarget === "card" && card ? `•••• ${card.last4}` : "Account balance"}
                      </span>
                      {card && (
                        <button
                          className="linkbtn"
                          onClick={() => setFundTarget(fundTarget === "card" ? "account" : "card")}
                        >
                          Change
                        </button>
                      )}
                    </div>

                    {/* the amount */}
                    <div className="ycard">
                      <div className="cap">USD · DEPOSIT</div>
                      <div className="big">${topUp}</div>
                      <div className="after">
                        +${(Number(topUp) * 0.99).toFixed(2)} credited after the 1% fee
                      </div>
                    </div>

                    <div className="chiprow" aria-label="Quick amounts">
                      {["20", "50", "100"].map((v) => (
                        <button key={v} onClick={() => setTopUp(v)}>
                          <small>USD</small>
                          <b>${v}</b>
                        </button>
                      ))}
                    </div>

                    {/* what to pay with on Robinhood Chain */}
                    <div className="seg" role="tablist" aria-label="Pay with">
                      {(["ETH", "USDG"] as const).map((a) => (
                        <button
                          key={a}
                          className={asset === a ? "on" : ""}
                          onClick={() => setAsset(a)}
                        >
                          {COIN[a]}
                          {a === "ETH" ? "ETH · gas token" : "USDG"}
                        </button>
                      ))}
                    </div>

                    <div className="metarows">
                      <div className="kv">
                        <span>Deposit fee (1%)</span>
                        <b>${(Number(topUp) * 0.01).toFixed(2)}</b>
                      </div>
                      <div className="kv">
                        <span>Lands on</span>
                        <b>{fundTarget === "card" && card ? `card •••• ${card.last4}` : "account balance"}</b>
                      </div>
                      <div className="kv">
                        <span>Minimum</span>
                        <b>${MIN_DEPOSIT} — gateway may refuse below ~$20</b>
                      </div>
                    </div>

                    <div className="numpad">
                      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                        <button key={d} onClick={() => tapDigit(d)}>
                          {d}
                        </button>
                      ))}
                      <button onClick={() => tapDigit(".")} aria-label="Decimal point">
                        .
                      </button>
                      <button onClick={() => tapDigit("0")}>0</button>
                      <button onClick={tapBack} aria-label="Delete digit">
                        {ic.back}
                      </button>
                    </div>

                    <button
                      className="btn dark sendbtn"
                      disabled={!!busy || Number(topUp) < MIN_DEPOSIT}
                      onClick={async () => {
                        setQuote(null);
                        const r = await run<{ deposit: Deposit }>("deposit", {
                          action: "deposit",
                          amount: Number(topUp),
                          cardId: fundTarget === "card" ? card?.cardId : undefined,
                        });
                        if (r) {
                          setDeposit(r.deposit);
                          await refresh();
                        }
                      }}
                    >
                      {ic.down}
                      {busy === "deposit" ? "Opening…" : "Open deposit"}
                    </button>
                  </div>
                </section>

                {deposit && (
                  <section className="panel">
                    <h4 className="ph phrow">{ic.send}Pay it</h4>
                    <table style={{ marginTop: ".6rem" }}>
                      <tbody>
                        <tr>
                          <th>Send</th>
                          <td><b>{deposit.pay_amount} {deposit.pay_currency}</b> on {deposit.network}</td>
                        </tr>
                        <tr><th>To</th><td><code>{deposit.pay_address}</code></td></tr>
                        <tr><th>Credited</th><td>${deposit.credited_on_completion_usd} (fee ${deposit.fee_usd})</td></tr>
                        <tr><th>Expires</th><td>{new Date(deposit.expires_at).toLocaleString()}</td></tr>
                      </tbody>
                    </table>

                    <div className="row" style={{ marginTop: ".8rem" }}>
                      <button
                        className="btn"
                        disabled={!!busy}
                        onClick={async () => {
                          setBusy("quote");
                          setErr("");
                          try {
                            setQuote(await quoteDepositPayment({ user: address!, deposit, asset }));
                          } catch (e) {
                            setErr((e as Error).message);
                          } finally {
                            setBusy("");
                          }
                        }}
                      >
                        {ic.chart}
                        {busy === "quote" ? "Quoting…" : "Quote the payment"}
                      </button>
                      <button
                        className="btn"
                        disabled={!!busy}
                        onClick={async () => {
                          const r = await run("apply", { action: "apply-deposit", depositId: deposit.id });
                          if (r) {
                            setOut(r);
                            setDeposit(null);
                            setQuote(null);
                            await refresh();
                          }
                        }}
                      >
                        {ic.check}
                        {busy === "apply" ? "Checking…" : "Apply the deposit"}
                      </button>
                    </div>

                    {quote && (
                      <>
                        <table style={{ marginTop: ".8rem" }}>
                          <tbody>
                            <tr><th>You pay</th><td>{quote.inFormatted} {quote.inSymbol} (${quote.inUsd})</td></tr>
                            <tr><th>They receive</th><td>{quote.outFormatted} USDT (${quote.outUsd})</td></tr>
                            <tr><th>Relay fee</th><td>${quote.feeUsd}</td></tr>
                            <tr><th>Signatures</th><td>{quote.txCount}, about {quote.etaSeconds}s</td></tr>
                          </tbody>
                        </table>
                        <button
                          className="btn dark"
                          style={{ marginTop: ".8rem" }}
                          disabled={!!busy || !walletClient}
                          onClick={async () => {
                            setBusy("pay");
                            setErr("");
                            try {
                              const status = await executePayment(quote, walletClient!, { onStage: setStage });
                              setStage("");
                              setOut({ relayStatus: status });
                              if (status !== "success") {
                                setErr(`Relay finished as "${status}" — the money did not arrive`);
                              }
                            } catch (e) {
                              setStage("");
                              setErr((e as Error).message);
                            } finally {
                              setBusy("");
                            }
                          }}
                        >
                          {ic.send}
                          {busy === "pay" ? "Paying…" : `Pay ${quote.inFormatted} ${quote.inSymbol}`}
                        </button>
                      </>
                    )}
                    <p className="sub" style={{ marginTop: ".6rem", fontSize: ".78rem" }}>
                      Applying asks the provider whether the money actually arrived. It refuses
                      until it has, and can only ever be applied once.
                    </p>
                  </section>
                )}
              </>
            )}

            {/* ============ SWAP — Robinhood Chain -> anywhere Relay reaches ============ */}
            {view === "swap" && (() => {
              const target = SWAP_TARGETS[swapTo] ?? SWAP_TARGETS[0];
              // Chain rail: unique network names, each with its brand dot.
              const CHAIN_DOT: Record<string, string> = {
                Robinhood: "#ccff00",
                Solana: "#9945ff",
                Base: "#0052ff",
                Ethereum: "#627eea",
                Arbitrum: "#12aaff",
              };
              const chainOf = (label: string) => label.split(" · ")[0];
              const networks = [...new Set(SWAP_TARGETS.map((t) => chainOf(t.label)))];
              const curNetwork = chainOf(target.label);

              // USD mode: the field holds dollars, the quote still wants tokens.
              const price = swapAsset === "ETH" ? ethPrice : 1;
              const tokenAmtStr = swapUsdMode
                ? price && Number(swapAmt) > 0
                  ? (Number(swapAmt) / price).toFixed(swapAsset === "ETH" ? 8 : 2)
                  : ""
                : swapAmt;
              const amtOk = Number(tokenAmtStr) > 0;

              // Max: full balance, minus gas headroom when spending the gas token
              // itself — an exact-max ETH swap can't pay for its own transaction.
              const GAS_RESERVE = 0.0005;
              const maxToken =
                swapAsset === "ETH"
                  ? Math.max(0, Number(ethBal ?? 0) - GAS_RESERVE)
                  : Number(usdgBal ?? 0);
              const fillMax = () => {
                setSwapQuote(null);
                setSwapAmt(
                  swapUsdMode
                    ? (maxToken * (price ?? 0)).toFixed(2)
                    : maxToken.toFixed(swapAsset === "ETH" ? 6 : 2)
                );
              };
              const rcptOk = target.solana
                ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(swapRcpt.trim())
                : /^0x[0-9a-fA-F]{40}$/.test(swapRcpt.trim());
              return (
                <div className="composer">
                  <div className="inner">
                    {/* ---- card 1: what leaves the wallet ---- */}
                    <section className="panel">
                      <div className="flabel">
                        <label>You pay</label>
                        <span className="hint" style={{ display: "inline-flex", alignItems: "center", gap: ".35rem" }}>
                          from <img src="/chains/robinhood.png" alt="" className="cimg" /> Robinhood Chain
                        </span>
                      </div>
                      <div className="seg" style={{ margin: ".35rem 0 .55rem" }}>
                        {(["ETH", "USDG"] as const).map((a) => (
                          <button
                            key={a}
                            className={swapAsset === a ? "on" : ""}
                            onClick={() => {
                              setSwapAsset(a);
                              setSwapQuote(null);
                            }}
                          >
                            {COIN[a]}
                            {a}
                          </button>
                        ))}
                      </div>
                      <div className="amountwrap">
                        <b>{swapUsdMode ? "$" : swapAsset === "ETH" ? "Ξ" : "$"}</b>
                        <input
                          value={swapAmt}
                          placeholder={swapUsdMode ? "20" : swapAsset === "ETH" ? "0.01" : "25"}
                          onChange={(e) => {
                            setSwapAmt(e.target.value);
                            setSwapQuote(null);
                          }}
                        />
                      </div>
                      <div className="amtchips">
                        {(swapUsdMode
                          ? ["10", "25", "50", "100"]
                          : swapAsset === "ETH"
                            ? ["0.005", "0.01", "0.05", "0.1"]
                            : ["10", "25", "50", "100"]
                        ).map((v) => (
                          <button
                            key={v}
                            className={swapAmt === v ? "on" : ""}
                            onClick={() => {
                              setSwapAmt(v);
                              setSwapQuote(null);
                            }}
                          >
                            {swapUsdMode ? `$${v}` : v}
                          </button>
                        ))}
                        <button onClick={fillMax}>Max</button>
                      </div>
                      <div
                        className="sub"
                        style={{ margin: ".45rem 0 0", fontSize: ".78rem", display: "flex", justifyContent: "space-between", gap: ".6rem", flexWrap: "wrap" }}
                      >
                        <span>
                          {swapUsdMode
                            ? `≈ ${tokenAmtStr || "0"} ${swapAsset}`
                            : price
                              ? `≈ $${(Number(swapAmt || 0) * price).toFixed(2)}`
                              : "USD value unavailable"}
                          {" · "}Balance: {swapAsset === "ETH" ? `${ethBal ?? "—"} ETH` : `${usdgBal ?? "—"} USDG`}
                        </span>
                        <button
                          className="linkbtn"
                          disabled={swapAsset === "ETH" && !ethPrice}
                          title={swapAsset === "ETH" && !ethPrice ? "No ETH price available" : undefined}
                          onClick={() => {
                            setSwapUsdMode(!swapUsdMode);
                            setSwapAmt("");
                            setSwapQuote(null);
                          }}
                        >
                          ⇄ enter in {swapUsdMode ? swapAsset : "USD"}
                        </button>
                      </div>
                    </section>

                    {/* connector badge — makes the two decks read as separate */}
                    <div className="swapdivider" aria-hidden>
                      {ic.down}
                    </div>

                    {/* ---- card 2: what arrives, and where ---- */}
                    <section className="panel" style={{ display: "flex", flexDirection: "column", gap: ".85rem" }}>
                      <div className="flabel">
                        <label>You receive</label>
                        <span className="hint">network · token</span>
                      </div>
                      <div className="seg multi" role="tablist" aria-label="Network">
                        {networks.map((n) => (
                          <button
                            key={n}
                            className={curNetwork === n ? "on" : ""}
                            onClick={() =>
                              setSwapTo(SWAP_TARGETS.findIndex((t) => chainOf(t.label) === n))
                            }
                          >
                            {n === "Robinhood" ? (
                              <img src="/chains/robinhood.png" alt="" className="cimg" />
                            ) : (
                              <i className="cdot" style={{ background: CHAIN_DOT[n] ?? "var(--muted)" }} />
                            )}
                            {n}
                          </button>
                        ))}
                      </div>
                      <div className="seg" role="tablist" aria-label="Token">
                        {SWAP_TARGETS.map((t, i) =>
                          chainOf(t.label) === curNetwork ? (
                            <button key={t.label} className={i === swapTo ? "on" : ""} onClick={() => setSwapTo(i)}>
                              {COIN[t.sym]}
                              {t.sym}
                            </button>
                          ) : null
                        )}
                      </div>

                    {/* the one green card on this menu: what arrives */}
                    <div className="ycard">
                      <div className="cap">{target.label.toUpperCase()}</div>
                      <div className="big" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: ".5rem" }}>
                        {COIN[target.sym]}
                        {swapQuote
                          ? `${Number(swapQuote.outFormatted).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${target.sym}`
                          : `0 ${target.sym}`}
                      </div>
                      <div className="after">
                        {swapQuote
                          ? `≈ $${swapQuote.outUsd} · Relay fee $${swapQuote.feeUsd}`
                          : "Get a quote to see what arrives"}
                      </div>
                    </div>

                    <div>
                      <div className="flabel">
                        <label htmlFor="swrc">Recipient</label>
                        <span className="hint">{target.solana ? "Solana address — not 0x" : "0x address"}</span>
                      </div>
                      <input
                        id="swrc"
                        value={swapRcpt}
                        placeholder={target.solana ? "base58…" : "0x…"}
                        onChange={(e) => {
                          setSwapRcpt(e.target.value);
                          setSwapQuote(null);
                        }}
                      />
                    </div>
                    </section>

                    {!swapQuote ? (
                      <button
                        className="btn dark sendbtn"
                        disabled={!!busy || !amtOk || !rcptOk}
                        onClick={async () => {
                          setBusy("squote");
                          setErr("");
                          try {
                            const amount =
                              swapAsset === "ETH" ? parseEther(swapAmt) : parseUnits(swapAmt, 6);
                            setSwapQuote(
                              await quoteSwap({
                                user: address!,
                                asset: swapAsset,
                                amount,
                                to: target,
                                recipient: swapRcpt.trim(),
                              })
                            );
                          } catch (e) {
                            setErr((e as Error).message);
                          } finally {
                            setBusy("");
                          }
                        }}
                      >
                        {ic.chart}
                        {busy === "squote" ? "Quoting…" : "Get quote"}
                      </button>
                    ) : (
                      <>
                        <div className="metarows">
                          <div className="kv">
                            <span>You spend</span>
                            <b>
                              {swapQuote.inFormatted} {swapQuote.inSymbol} (${swapQuote.inUsd})
                            </b>
                          </div>
                          <div className="kv">
                            <span>Relay fee</span>
                            <b>${swapQuote.feeUsd}</b>
                          </div>
                          <div className="kv">
                            <span>Signatures</span>
                            <b>
                              {swapQuote.txCount}, about {swapQuote.etaSeconds}s
                            </b>
                          </div>
                        </div>
                        <button
                          className="btn dark sendbtn"
                          disabled={!!busy || !walletClient}
                          onClick={async () => {
                            setBusy("swap");
                            setErr("");
                            try {
                              const status = await executePayment(swapQuote, walletClient!, {
                                onStage: setStage,
                              });
                              setStage("");
                              setOut({ relayStatus: status });
                              if (status === "success") {
                                setSwapQuote(null);
                                setSwapAmt("");
                                refreshBalances();
                              } else {
                                setErr(`Relay finished as "${status}" — check before retrying`);
                              }
                            } catch (e) {
                              setStage("");
                              setErr((e as Error).message);
                            } finally {
                              setBusy("");
                            }
                          }}
                        >
                          {ic.swap}
                          {busy === "swap" ? "Swapping…" : `Swap ${swapAsset} → ${target.sym}`}
                        </button>
                      </>
                    )}
                    <p className="sub" style={{ margin: "0", fontSize: ".78rem" }}>
                      Mainnet — this moves real funds. The quote expires quickly; if it goes
                      stale, get a fresh one.
                    </p>
                  </div>
                </div>
              );
            })()}

            {/* ============ HISTORY — wallet + card on one timeline ============ */}
            {view === "history" && (
              <>
                <section className="panel">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
                    <div>
                      <h4 className="ph phrow">{ic.chart}Activity</h4>
                      <p className="sub" style={{ margin: ".2rem 0 0" }}>
                        Money moved, wallet and card together.
                      </p>
                    </div>
                    <b className="serif" style={{ fontSize: "1.55rem", whiteSpace: "nowrap" }}>
                      {fm(histTotal)}
                    </b>
                  </div>

                  <div className="seg" style={{ maxWidth: 300, margin: ".8rem 0" }}>
                    {(["1D", "1W", "1M", "ALL"] as const).map((t) => (
                      <button key={t} className={tf === t ? "on" : ""} onClick={() => setTf(t)}>
                        {t === "ALL" ? "All" : t}
                      </button>
                    ))}
                  </div>

                  {/* stacked volume per bucket — blue wallet, orange card (validated pair) */}
                  <svg viewBox="0 0 600 150" style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Activity volume over time">
                    <text x="0" y="10" style={{ font: "10px var(--font-sans), sans-serif", fill: "var(--muted)" }}>
                      {histMax === 1 && histTotal === 0 ? fm(0) : fm(histMax)}
                    </text>
                    {cols.map((c, i) => {
                      const bw = 600 / cols.length;
                      const wh = (c.wallet / histMax) * 110;
                      const ch = (c.card / histMax) * 110;
                      const x = i * bw + bw * 0.2;
                      return (
                        <g key={i}>
                          <title>{`${tfLabel(c.t)} — wallet $${c.wallet.toFixed(2)} · card $${c.card.toFixed(2)}`}</title>
                          {wh > 0 && (
                            <rect x={x} y={126 - wh} width={bw * 0.6} height={wh} rx="2" fill="#3b6fb5" />
                          )}
                          {ch > 0 && (
                            <rect x={x} y={126 - wh - ch - (wh > 0 ? 2 : 0)} width={bw * 0.6} height={ch} rx="2" fill="#e8781f" />
                          )}
                        </g>
                      );
                    })}
                    <line x1="0" y1="127" x2="600" y2="127" stroke="rgba(33,31,26,.14)" />
                    <text x="0" y="142" style={{ font: "10px var(--font-sans), sans-serif", fill: "var(--muted)" }}>
                      {tfLabel(cols[0].t)}
                    </text>
                    <text x="600" y="142" textAnchor="end" style={{ font: "10px var(--font-sans), sans-serif", fill: "var(--muted)" }}>
                      {tfLabel(cols[cols.length - 1].t)}
                    </text>
                    {histTotal === 0 && (
                      <text x="300" y="80" textAnchor="middle" style={{ font: "11px var(--font-sans), sans-serif", fill: "var(--muted)" }}>
                        {walletEvents === null ? "Loading…" : "No activity in this range"}
                      </text>
                    )}
                  </svg>

                  <div className="hlegend" style={{ marginTop: ".5rem" }}>
                    <span className="pair">
                      <i className="adot" style={{ background: "#3b6fb5" }} />
                      <span>Wallet</span>
                      <b>{fm(cols.reduce((s, c) => s + c.wallet, 0))}</b>
                    </span>
                    <span className="pair">
                      <i className="adot" style={{ background: "#e8781f" }} />
                      <span>Card</span>
                      <b>{fm(cols.reduce((s, c) => s + c.card, 0))}</b>
                    </span>
                  </div>
                </section>

                <section className="panel rh">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <h4 className="ph phrow">{ic.clock}All Transactions</h4>
                    <button
                      className="btn"
                      disabled={!!busy}
                      onClick={() => {
                        setWalletEvents(null);
                        setTxs(null); // both auto-load effects refire
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                  <p className="sub" style={{ marginBottom: ".4rem" }}>
                    Latest wallet transfers (via Blockscout) and card charges, newest first.
                  </p>

                  {inRange.map((e, i) => (
                    <div className="rowitem" key={i}>
                      <span className="chip">
                        {e.source === "card" ? ic.card : (COIN[e.sym] ?? ic.wallet)}
                      </span>
                      <div className="meta">
                        <b>{e.label}</b>
                        <small>
                          {e.ts ? new Date(e.ts).toLocaleString() : "—"} · {e.sub}
                        </small>
                      </div>
                      <span className="amt">
                        <span className={`dot ${e.ok ? (e.dir === "in" ? "g" : "o") : "r"}`} />
                        {e.dir === "in" ? "+" : "−"}
                        {e.sym === "USD"
                          ? `$${e.qty.toFixed(2)}`
                          : `${e.qty.toLocaleString(undefined, { maximumFractionDigits: 5 })} ${e.sym}`}
                      </span>
                    </div>
                  ))}
                  {walletEvents !== null && inRange.length === 0 && (
                    <Empty
                      title="Nothing in this range"
                      sub="Try a wider timeframe — All shows everything."
                    />
                  )}
                  {walletEvents === null && <p className="sub">Loading wallet history…</p>}
                </section>
              </>
            )}

            {/* ============ SETTINGS ============ */}
            {view === "settings" && (
              <div className="composer">
                <div className="inner">
                  <section className="panel">
                    <h4 className="ph phrow">{ic.wallet}Account</h4>
                    <div className="metarows" style={{ marginTop: ".4rem" }}>
                      <div className="kv">
                        <span>Wallet</span>
                        <b style={{ display: "inline-flex", alignItems: "center", gap: ".4rem" }}>
                          {short(address!)}
                          <button
                            className="linkbtn"
                            aria-label="Copy address"
                            onClick={() => {
                              navigator.clipboard.writeText(address!);
                              setCopied(true);
                              setTimeout(() => setCopied(false), 1500);
                            }}
                          >
                            {copied ? ic.check : ic.copy}
                          </button>
                        </b>
                      </div>
                      <div className="kv">
                        <span>Login</span>
                        <b>Privy · embedded wallet</b>
                      </div>
                    </div>
                    <button className="btn" style={{ marginTop: ".8rem" }} onClick={logout}>
                      {ic.out}
                      Sign out
                    </button>
                  </section>

                  <section className="panel">
                    <h4 className="ph phrow">{ic.eye}Preferences</h4>
                    <div className="kv" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: ".5rem" }}>
                      <div>
                        <b style={{ fontSize: ".9rem" }}>Hide balances</b>
                        <p className="sub" style={{ margin: 0, fontSize: ".78rem" }}>
                          Masks every amount across the app.
                        </p>
                      </div>
                      <button
                        className={hideBal ? "switch on" : "switch"}
                        role="switch"
                        aria-checked={hideBal}
                        aria-label="Hide balances"
                        onClick={() => setHideBal(!hideBal)}
                      />
                    </div>
                  </section>

                  <section className="panel">
                    <h4 className="ph phrow">{ic.shield}Wallet security</h4>
                    <p className="sub" style={{ margin: ".3rem 0 .7rem" }}>
                      Reveals the private key through Privy&rsquo;s secure dialog. Anyone holding
                      it controls the wallet and every card on it — never share it.
                    </p>
                    <button className="btn" onClick={() => void exportWallet()}>
                      {ic.qr}
                      Export private key
                    </button>
                  </section>

                  <section className="panel">
                    <h4 className="ph phrow">{ic.spark}Network</h4>
                    <div className="metarows" style={{ marginTop: ".4rem" }}>
                      <div className="kv">
                        <span>Network</span>
                        <b style={{ display: "inline-flex", alignItems: "center", gap: ".35rem" }}>
                          <img src="/chains/robinhood.png" alt="" className="cimg" /> Robinhood Chain
                        </b>
                      </div>
                      <div className="kv"><span>Chain ID</span><b>{robinhoodChain.id}</b></div>
                      <div className="kv"><span>Gas token</span><b>ETH</b></div>
                      <div className="kv">
                        <span>Explorer</span>
                        <b>
                          <a
                            href={`${robinhoodChain.blockExplorers!.default.url}/address/${address}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Blockscout ↗
                          </a>
                        </b>
                      </div>
                    </div>
                  </section>

                  <p className="sub" style={{ textAlign: "center", fontSize: ".75rem" }}>
                    HoodBank · powered by Kripicard, Relay &amp; Privy
                  </p>
                </div>
              </div>
            )}

            {out != null && (
              <details className="raw">
                <summary>Raw response</summary>
                <pre>{JSON.stringify(out, null, 2)}</pre>
              </details>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
