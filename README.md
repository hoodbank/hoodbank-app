# HoodBank App

A self-custodial wallet for Robinhood Chain, with a Visa card attached to it.

Hold ETH and USDG, swap across seven chains, and spend the balance on a virtual
Visa card that works with Apple Pay, Samsung Pay and Google Pay. No bank account
in the loop, and the private key stays exportable.

**Live:** [wallet.hoodbank.org](https://wallet.hoodbank.org) · [hoodbank.org](https://hoodbank.org)

---

## What it does

| | |
| --- | --- |
| **Assets** | ETH and USDG balances read from chain, portfolio value in USD, IDR, JPY, EUR or GBP. Send, receive, scan a QR. |
| **Swap** | Robinhood Chain → Solana, Base, Ethereum or Arbitrum in one signature. Quote first; the fee and ETA are on screen before you commit. |
| **Cards** | Issue a virtual Visa in seconds. Reveal the number, freeze it, read its history. |
| **Top up** | Open a deposit, pay it from your own wallet, apply the credit to a card. |
| **History** | Wallet transfers and card spending on one timeline, charted over 1D / 1W / 1M / All. |

## How the money actually moves

Cards are issued under a provider account, so a card has to be paid for from a
balance held there. Funding one is therefore three steps, not one:

1. **Open a deposit** — the server asks the card provider for a payment address.
2. **Pay it on-chain** — routed from Robinhood Chain to the provider's rail
   (USDT on Solana) through [Relay](https://relay.link). Quoted `EXACT_OUTPUT`,
   because a deposit is only credited when the exact amount lands.
3. **Apply it** — the server asks the provider whether the money arrived, then
   funds the card.

Step 3 is not a formality. A client claiming payment landed is not evidence, so
the provider is asked directly, and the deposit is claimed atomically — a retry
or a second tab cannot fund a card twice off one payment. If funding then fails,
the deposit returns to pending instead of vanishing.

## Fees

| | |
| --- | --- |
| Card issuance | $5.00 once per card |
| Card funding | $1.00 + 4% |
| Deposit | 1% |
| Closing a card | $2.00 off the refund |
| Swaps | Relay's quote, shown before signing |

A card opened with a $10 load costs **$16.40**. The $5 is charged once, so
larger first loads lose proportionally less. The app shows the breakdown before
you confirm.

## Architecture

Next.js App Router. One deployment serves both hosts — `proxy.ts` rewrites the
apex to the landing page and leaves the wallet at `/`.

```
app/
  page.tsx          the wallet (client; Privy + viem)
  home/             the landing page (server-rendered, no wallet code)
  api/cards/        every card action; auth + ownership enforced here
  api/rpc/          same-origin JSON-RPC proxy
  api/fx/           display-currency rates, cached hourly
  store.ts          card ownership + deposits (Postgres, JSON file in dev)
src/
  kripicard.ts      card provider client — server only
  pay.ts            Relay quoting and execution — runs in the browser
```

Three boundaries hold the thing together:

- **The provider key never reaches a browser.** `src/kripicard.ts` throws on
  import if it finds a `window`, and package exports keep it on `/server`.
- **Card ownership lives in our database, not theirs.** The provider has no idea
  which wallet a card belongs to; that mapping is the only thing standing
  between a user and someone else's card number, so every card action checks it.
- **The caller is verified, never asserted.** Routes read the wallet address
  from a verified Privy token, never from the request body.

In front of the provider sits our own rate limiter, 6/minute per wallet. Their
limit is enforced on the API key, so without it one impatient tab would take
cards down for every user at once.

## Running it

Requires Node 20+ and a Postgres URL (Neon's free tier is fine).

```bash
npm install
cp .env.example .env    # then fill it in
npm run dev
```

```bash
npm test          # money paths: fee maths, ownership, double-fund, release-on-failure
npm run typecheck
npm run build
```

`.env.example` documents every variable. `DATABASE_URL` is required in
production — without it the file-based dev store refuses to start rather than
lose cards that were already paid for.

## Notes worth knowing

- **Mainnet only.** Relay does not route to Robinhood testnet, and the card
  provider settles in real USDT. There is no practice mode; every signature
  moves real money.
- **Card assets in the swap picker** are drawn inline as SVG. The Content
  Security Policy blocks external images, so nothing is fetched from a CDN.
- **Deposits below roughly $16 are refused** by the payment gateway with an
  empty 400, even though $10 is the documented minimum. The check stays at $10
  and the refusal is surfaced as-is; the floor appears to be the gateway's, not
  the card provider's, so hardcoding it would rot.

## Disclaimer

HoodBank is a financial technology product, not a bank. Cards are issued by a
third-party issuer and balances held there are not covered by deposit
insurance. Crypto assets are volatile, and on-chain transactions cannot be
reversed.
