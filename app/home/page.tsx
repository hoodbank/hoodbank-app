// hoodbank.org — the marketing home. Server-rendered, no wallet code: this page
// must load fast for people who have never heard of us, so it pulls in neither
// Privy nor viem.
//
// Every number here is one we verified against the live provider. No invented
// user counts, no "trusted by" logos we don't have — a card product that
// overstates itself is exactly the kind people stop trusting.

import type { Metadata } from "next";
import { LandingNav } from "./nav";
import "./landing.css";

const WALLET = "https://wallet.hoodbank.org";

export const metadata: Metadata = {
  title: "HoodBank — a Visa card that spends your Robinhood Chain balance",
  description:
    "Hold ETH and USDG on Robinhood Chain, swap across 7 chains, and spend it on a Visa card with Apple Pay, Samsung Pay and Google Pay. Non-custodial.",
  alternates: { canonical: "https://hoodbank.org" },
};

const FEATURES = [
  { v: "card", title: "A real Visa card, instantly", body: "Virtual card in seconds — Apple Pay, Samsung Pay, Google Pay." },
  { v: "lock", title: "Your keys, your money", body: "Non-custodial wallet; the private key exports whenever you want." },
  { v: "swap", title: "Swap across 7 chains", body: "Robinhood Chain to Solana, Base, Ethereum, Arbitrum — one step." },
  { v: "rows", title: "Funded from your wallet", body: "Top up with the ETH or USDG you already hold. No bank in the loop." },
  { v: "chart", title: "One timeline", body: "Wallet and card activity together, charted by day, week or month." },
  { v: "frz", title: "Freeze in one tap", body: "Lock the card instantly; details stay hidden until you reveal them." },
];

/** The five network marks that orbit the HoodBank hub. */
const CHAIN_MARKS = [
  <img key="rh" src="/chains/robinhood.png" alt="Robinhood Chain" />,
  <svg key="sol" width="18" height="18" viewBox="0 0 20 20" aria-label="Solana">
    <defs>
      <linearGradient id="lps" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stopColor="#00ffa3" />
        <stop offset="1" stopColor="#dc1fff" />
      </linearGradient>
    </defs>
    <path d="M6 5h9l-1.8 2H4.2L6 5Zm0 8h9l-1.8 2H4.2L6 13Zm7.8-4H4.8L6.6 11h9L13.8 9Z" fill="url(#lps)" />
  </svg>,
  <svg key="base" width="18" height="18" viewBox="0 0 20 20" aria-label="Base">
    <circle cx="10" cy="10" r="9" fill="#0052ff" />
    <rect x="2.5" y="8.6" width="9" height="2.8" rx="1.4" fill="#fff" />
  </svg>,
  <svg key="eth" width="18" height="18" viewBox="0 0 20 20" aria-label="Ethereum">
    <path d="M10 1.5 4.5 10.2 10 13.5l5.5-3.3L10 1.5Z" fill="#627eea" />
    <path d="m4.5 11.6 5.5 7 5.5-7L10 14.8l-5.5-3.2Z" fill="#8ba2f0" />
  </svg>,
  <svg key="arb" width="18" height="18" viewBox="0 0 20 20" aria-label="Arbitrum">
    <circle cx="10" cy="10" r="9" fill="#213147" />
    <path d="m7 14 3-8 3 8-1.8-1-1.2-3.4L8.8 13 7 14Z" fill="#12aaff" />
  </svg>,
];

/** The animated in-card illustrations, one per feature. */
function Visual({ v }: { v: string }) {
  switch (v) {
    case "card":
      return <img className="v-img" src="/features/card.png" alt="" loading="lazy" />;
    case "lock":
      return <img className="v-img" src="/features/keys.png" alt="" loading="lazy" />;
    case "swap":
      return (
        <div className="v-orbit">
          <div className="track" />
          <div className="ring">
            {CHAIN_MARKS.map((mark, i) => (
              <span
                key={i}
                className="pos"
                style={{ transform: `rotate(${i * 72}deg) translateX(96px)` }}
              >
                <span className="unrot" style={{ transform: `rotate(${i * -72}deg)` }}>
                  <span className="ch">{mark}</span>
                </span>
              </span>
            ))}
          </div>
          <img className="hub" src="/features/hood.png" alt="" loading="lazy" />
        </div>
      );
    case "rows":
      return <img className="v-img" src="/features/fund.png" alt="" loading="lazy" />;
    case "chart":
      return <img className="v-img" src="/features/timeline.png" alt="" loading="lazy" />;
    case "frz":
      return (
        <div className="v-frz">
          <span className="ast">
            <i />
          </span>
        </div>
      );
    default:
      return null;
  }
}

const STEPS = [
  {
    title: "Fund your wallet",
    body: "Sign in and you get a Robinhood Chain address. Send ETH or USDG to it, or bridge in from another chain.",
  },
  {
    title: "Top up your balance",
    body: "Open a deposit, pay it straight from your wallet, and the credit lands on your HoodBank balance.",
  },
  {
    title: "Create your card and spend",
    body: "Issue the card in seconds, reveal the number, add it to your phone's wallet, and pay.",
  },
];

const FAQ = [
  {
    q: "Do I need a bank account?",
    a: "No. HoodBank runs on your crypto balance — you fund the wallet on-chain and spend from it. There is no bank onboarding and no wire transfer in the loop.",
  },
  {
    q: "What does the first card actually cost?",
    a: "A card opened with a $10 load costs $16.40 off your balance: the $10 you can spend, a one-time $5 issuance fee, $1 processing and 4% funding. The $5 is charged once, so larger first loads waste proportionally less — the app shows the full breakdown before you confirm.",
  },
  {
    q: "Who holds my funds?",
    a: "You do. The wallet is non-custodial and its private key is exportable from Settings at any time. Money only leaves your wallet when you sign a transaction. Card balances sit with the card issuer, as they must for any card.",
  },
  {
    q: "Which assets can I spend?",
    a: "ETH and USDG on Robinhood Chain. Assets on other chains can be swapped in first — Solana, Base, Ethereum and Arbitrum are routed in a single step.",
  },
  {
    q: "Where does the card work?",
    a: "Anywhere Visa is accepted, including online checkouts and subscriptions. Add it to Apple Pay, Samsung Pay or Google Pay for in-store tap-to-pay.",
  },
  {
    q: "Is HoodBank a bank?",
    a: "No. HoodBank is software on top of a licensed card issuer and public blockchain infrastructure. Deposits are not insured, and crypto balances can lose value.",
  },
];

export default function Landing() {
  return (
    <div className="lp">
      <LandingNav />

      {/* Everything below blurs while the nav menu is open — real blur that
          works even where the browser refuses backdrop-filter. The nav sits
          outside this wrapper so it stays sharp. */}
      <div className="lp-body">

      {/* ---------- hero ---------- */}
      <section className="lp-hero">
        <div className="wrap">
          <h1>
            Pay anything, anywhere,
            <br />
            <em>just one tap.</em>
          </h1>
          <p className="lead">
            Your Robinhood Chain balance, on a Visa card. No bank, no waiting — and the keys
            stay yours.
          </p>
          <div className="lp-actions">
            <a className="lp-cta" href={WALLET}>
              Open wallet
            </a>
            <a className="lp-cta ghost" href="#how">
              See how it works
            </a>
          </div>

          <div className="lp-cardwrap">
            {/* giant ticker running behind the card */}
            <div className="lp-marq" aria-hidden>
              <div className="track">
                <span>HOODBANK&nbsp;✱&nbsp;HOODBANK&nbsp;✱&nbsp;HOODBANK&nbsp;✱&nbsp;HOODBANK&nbsp;✱&nbsp;</span>
                <span>HOODBANK&nbsp;✱&nbsp;HOODBANK&nbsp;✱&nbsp;HOODBANK&nbsp;✱&nbsp;HOODBANK&nbsp;✱&nbsp;</span>
              </div>
            </div>
            <img className="lp-heroimg" src="/features/coverage.png" alt="HoodBank Visa card" />
          </div>
        </div>
      </section>

      {/* ---------- features ---------- */}
      <section id="features">
        <div className="wrap">
          <h2 className="lp-bigcaps">
            HoodBank
            <br />
            Features
          </h2>
          <p className="sectionsub" style={{ marginTop: "1rem" }}>
            One wallet, one card, one history — with nothing about fees or custody left as a
            surprise.
          </p>
          <div className="lpf-grid">
            {FEATURES.map((f, i) => (
              <article className="lpf" key={f.title}>
                <div className={`lpf-card ${(i + Math.floor(i / 2)) % 2 ? "grey" : "green"}`}>
                  <Visual v={f.v} />
                </div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section id="how" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <h2>Three steps to your first payment.</h2>
          <p className="sectionsub">From an empty wallet to a card you can tap, without leaving the app.</p>
          <div className="lp-steps">
            {STEPS.map((s, i) => (
              <a className={i === 1 ? "lp-step green" : "lp-step"} key={s.title} href={WALLET}>
                <div className="n">{i + 1}</div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <span className="golink">Open the wallet →</span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- global coverage ---------- */}
      <section id="coverage" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <h2 className="lp-bigcaps">
            Global
            <br />
            Coverage
          </h2>
          <div className="lp-cov" style={{ marginTop: "2rem" }}>
            <div className="covtext">
              <div className="regions">
                LATAM
                <br />
                Asia-Pacific
                <br />
                Middle East
                <br />
                Europe
              </div>
              <p>
                HoodBank works anywhere Visa is accepted — online and in-store through Apple
                Pay, Samsung Pay and Google Pay. Availability depends on local regulations.
              </p>
            </div>
            <div className="covvis" aria-hidden>
              <div className="globe" />
              <i className="spark" style={{ top: "18%", right: "22%" }} />
              <i className="spark" style={{ top: "38%", right: "6%", animationDelay: ".8s" }} />
              <i className="spark" style={{ top: "70%", right: "30%", animationDelay: "1.6s" }} />
              <i className="spark" style={{ top: "12%", right: "48%", animationDelay: "2.2s" }} />
              <i className="spark" style={{ top: "82%", right: "10%", animationDelay: "1.1s" }} />
              <img className="covcard" src="/features/coverage.png" alt="" loading="lazy" />
            </div>
          </div>
        </div>
      </section>

      {/* ---------- faq ---------- */}
      <section id="faq" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <h2>Questions worth asking.</h2>
          <div className="lp-faq" style={{ marginTop: "1.5rem" }}>
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- closing ---------- */}
      <section style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="lp-band">
            <h2>Your money, unlocked.</h2>
            <p>Open the wallet, fund it, and issue a card in the same sitting.</p>
            <a className="lp-cta" href={WALLET}>
              Open wallet
            </a>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="wrap">
          <div className="cols">
            <div>
              <div className="brand">
                <img src="/logo.png" alt="" />
                HoodBank
              </div>
              <p style={{ color: "#a8a599", fontSize: ".86rem", margin: 0 }}>
                A Visa card for your Robinhood Chain balance.
              </p>
            </div>
            <div className="links">
              <a href="#features">Features</a>
              <a href="#how">How it works</a>
              <a href="#coverage">Coverage</a>
              <a href="#faq">FAQ</a>
              <a href={WALLET}>Open wallet</a>
            </div>
          </div>
          <p className="lp-disc">
            HoodBank is a financial technology company, not a bank. Cards are issued by a
            third-party card issuer; card balances are held by that issuer and are not insured by
            any deposit insurance scheme. Crypto assets are volatile and can lose value. On-chain
            transactions are irreversible. Nothing here is financial advice.
          </p>
          <p className="lp-disc" style={{ marginTop: ".8rem" }}>
            © {new Date().getFullYear()} HoodBank
          </p>
        </div>
      </footer>
      </div>
    </div>
  );
}
