import type { NextConfig } from "next";

// Security headers, per Privy's implementation guide. A wallet holds real
// funds, so framing is locked (anti-clickjacking), HTTPS forced, and
// referrer/permissions leakage trimmed.
//
// Two connect-src entries are app-specific: `src/pay.ts` quotes Relay straight
// from the browser, and viem may reach the chain's RPC directly. Both are
// cross-origin fetches, and leaving them out breaks the payment leg with a
// console error and nothing else.
//
// 'unsafe-inline' in script-src is required by Next's bootstrap inline scripts
// (no nonce plumbing yet); external script hosts stay blocked. Dev-only: HMR
// needs eval, and it is never in the production header.
const devEval = process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : "";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${devEval} https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // The pair that answers Privy's "X-Frame options" item: nobody may frame us.
  "frame-ancestors 'none'",
  // …while these let us frame Privy's embedded-wallet iframe, which is the
  // thing their "protect the embedded wallet iframe" item is about.
  "child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org",
  "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com",
  [
    "connect-src 'self'",
    "https://auth.privy.io",
    "https://*.rpc.privy.systems",
    // rhcard-specific — see the note above.
    "https://api.relay.link",
    "https://rpc.mainnet.chain.robinhood.com",
    // Wallet history for the History view — Blockscout is the only indexer
    // that can answer "what has this address done", an RPC can't.
    "https://robinhoodchain.blockscout.com",
    "wss://relay.walletconnect.com",
    "wss://relay.walletconnect.org",
    "wss://www.walletlink.org",
    "https://explorer-api.walletconnect.com",
  ].join(" "),
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
];

const config: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
