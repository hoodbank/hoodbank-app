// Kripicard client — visa card transactions for a Robinhood Chain project.
//
// SERVER ONLY, and it has to stay that way: every card is issued under ONE
// provider account, so this key can create, read and drain every user's card.
// It must never reach a browser bundle.
//
// Base URL: the paths on the public docs page (home.kripicard.com/api/premium/*)
// return 404. The live API is appapi.kripicard.com/api/external/* — verified
// against the running service.
//
// Their rate limit is strict and punitive: tripping it blocks the KEY, so every
// user goes down at once, for minutes rather than seconds. Never call this per
// render. Read cards from your own store and hit the provider only when the
// user asks for something live.

if (typeof window !== "undefined") {
  throw new Error("rhcard/server was imported in a browser — the API key controls every card");
}

const DEFAULT_BASE = "https://appapi.kripicard.com";

/**
 * Provider floor, in USD — creation, funding and deposits alike.
 *
 * Deposits carry a caveat worth knowing: probed against the live API, $10 and
 * $15 come back as a bare 400 while $20 succeeds. That looks like a payment
 * gateway's minimum for USDT-on-Solana rather than a Kripicard rule, so it can
 * move on its own and is not worth hardcoding. A rejected deposit surfaces as
 * "Card provider returned 400" — their 400 body is empty, so there is nothing
 * better to pass through.
 */
export const MIN_USD = 10;

/** BINs the provider issues on that additionally require a date of birth. */
export const DOB_REQUIRED_BINS = new Set(["537872", "533171", "246001"]);

/**
 * What actually lands on a card after the provider's funding fee ($1 flat + 4%),
 * rounded down to cents — rounding up asks the account for money it hasn't got.
 */
export function netOnCard(creditUsd: number): number {
  return Math.floor(((creditUsd - 1) / 1.04) * 100) / 100;
}

/* ---------- provider payloads ---------- */

export interface CreatedCard {
  card_id: string;
  last_4: string;
  bin: string;
  amount: number;
  fee: number;
  total_charged: number;
}

export interface CardDetails {
  card_number: string;
  expiry: string;
  cvv: string;
  balance: number;
  status: string;
}

export interface CardTransaction {
  date: string;
  type: string;
  merchant: string;
  amount: number;
  currency: string;
  status: string;
}

export interface Deposit {
  id: string;
  status: string;
  amount_usd: number;
  /** Their cut, 1% at time of writing — separate from the card funding fee. */
  fee_usd: number;
  credited_on_completion_usd: number;
  /** Where to send. A Solana address when network is "sol", so not a 0x string. */
  pay_address: string;
  /** Send at least this much; slightly above amount_usd to absorb rounding. */
  pay_amount: string;
  pay_currency: string;
  network: string;
  /** ISO. The address stops accepting after this — quote and send inside it. */
  expires_at: string;
}

export interface DepositStatus {
  id: string;
  status: string;
  /** The only trustworthy signal that money actually arrived. */
  credited: boolean;
  credited_amount_usd: number;
  amount_usd: number;
  fee_usd: number;
  gateway_status?: string;
}

/* ---------- the store your app must supply ---------- */

export interface CardRecord {
  cardId: string;
  /** Owning Robinhood Chain wallet, lowercase. */
  owner: string;
  /** Last four digits — safe to list without another provider call. */
  last4: string;
  bin: string;
  /** Name embossed on the card. The provider never gives it back, so it is
   *  kept here or it is lost. */
  holder: string;
}

export interface DepositRecord {
  depositId: string;
  owner: string;
  /** Card to fund once it lands; null means the user is paying for a new one. */
  cardId: string | null;
  /** What the account gets credited, after the provider's deposit fee. */
  creditUsd: number;
}

/**
 * Your durable side of the integration. The provider has no idea which wallet a
 * card belongs to — that mapping exists only here, and it is the only thing
 * standing between a user and someone else's card number. Back it with a real
 * database; an in-memory one loses cards that have already been paid for.
 */
export interface CardStore {
  ownsCard(owner: string, cardId: string): Promise<boolean>;
  recordCard(rec: CardRecord): Promise<void>;
  forgetCard(cardId: string): Promise<void>;
  recordDeposit(rec: DepositRecord): Promise<void>;
  /**
   * Flip pending → applied ATOMICALLY, returning the row only to the caller
   * that won the flip (null to everyone else). Two tabs polling one deposit
   * must not both fund a card off it. A `update ... where status='pending'
   * returning *` does this; a read-then-write does not.
   */
  claimDeposit(depositId: string, owner: string): Promise<DepositRecord | null>;
  /** Back to pending, for when funding fails after the claim. */
  releaseDeposit(depositId: string): Promise<void>;
}

/* ---------- client ---------- */

export interface CardsConfig {
  /** KRIPICARD_API_KEY. Server env only. */
  apiKey: string;
  store: CardStore;
  baseUrl?: string;
}

const norm = (owner: string) => owner.trim().toLowerCase();

function assertAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount < MIN_USD) {
    throw new Error(`Minimum is $${MIN_USD}`);
  }
}

export function createCards({ apiKey, store, baseUrl = DEFAULT_BASE }: CardsConfig) {
  if (!apiKey) throw new Error("Cards are not configured: missing KRIPICARD_API_KEY");

  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, ...body }),
      cache: "no-store",
    });

    const json = (await res.json().catch(() => null)) as
      | ({ success?: boolean; message?: string; error?: string } & Record<string, unknown>)
      | null;

    if (!json) throw new Error(`Card provider returned ${res.status}`);
    // They answer 200 with success:false for business errors, and their
    // rate-limit message is the useful one — pass it through rather than
    // flattening it into "something went wrong".
    if (json.success === false || !res.ok) {
      throw new Error(json.message ?? json.error ?? `Card provider returned ${res.status}`);
    }
    return json as T;
  }

  async function guard(owner: string, cardId: string): Promise<void> {
    if (!cardId) throw new Error("cardId is required");
    // Same message whether the card doesn't exist or belongs to someone else —
    // a distinct one would let a caller probe which card ids are real.
    if (!(await store.ownsCard(norm(owner), cardId))) throw new Error("Card not found");
  }

  const fund = (cardId: string, amount: number) =>
    call<{ data: { card_id: string; amount: number; fee: number; total_debited: number } }>(
      "/api/external/cards/fundcard",
      { card_id: cardId, amount }
    );

  return {
    /** Issues a card against the account balance and records who owns it. */
    async create(
      owner: string,
      input: {
        bin: string;
        amount: number;
        nameOnCard: string;
        email?: string;
        dateOfBirth?: string;
        }
    ): Promise<CreatedCard> {
      const holder = input.nameOnCard.trim();
      if (!input.bin) throw new Error("Pick a card BIN");
      assertAmount(input.amount);
      if (holder.length < 2) throw new Error("Enter the name on card");
      if (DOB_REQUIRED_BINS.has(input.bin) && !input.dateOfBirth) {
        throw new Error("This BIN requires a date of birth");
      }

      const card = await call<CreatedCard>("/api/external/cards/createcard", {
        bin: input.bin,
        amount: input.amount,
        name_on_card: holder,
        ...(input.email ? { email: input.email } : {}),
        ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
      });

      // Record before returning: a card we forget about is a card its owner can
      // never reach again, and the money is already spent.
      await store.recordCard({
        cardId: card.card_id,
        owner: norm(owner),
        last4: card.last_4 ?? "",
        bin: card.bin ?? input.bin,
        holder,
      });
      return card;
    },

    /** Tops a card up straight from the account balance. */
    async fund(owner: string, cardId: string, amount: number) {
      await guard(owner, cardId);
      assertAmount(amount);
      return fund(cardId, amount);
    },

    /** PAN, expiry and CVV. Frozen cards may be refused by the provider. */
    async details(owner: string, cardId: string): Promise<CardDetails> {
      await guard(owner, cardId);
      return call<CardDetails>("/api/external/cards/carddetails", { card_id: cardId });
    },

    /** Spend history. */
    async transactions(owner: string, cardId: string) {
      await guard(owner, cardId);
      return call<{
        data: {
          card_id: string;
          balance: number;
          total_transactions: number;
          transactions: CardTransaction[];
        };
      }>("/api/external/cards/transactions", { card_id: cardId });
    },

    async setFrozen(owner: string, cardId: string, frozen: boolean) {
      await guard(owner, cardId);
      return call<{ message?: string }>("/api/external/premium/Freeze_Unfreeze", {
        card_id: cardId,
        action: frozen ? "freeze" : "unfreeze",
      });
    },

    /** Irreversible. Returns the remaining balance minus their $2 cashout fee. */
    async close(owner: string, cardId: string) {
      await guard(owner, cardId);
      const out = await call<{ refunded: number; fee: number; message?: string }>(
        "/api/external/cards/deletecard",
        { card_id: cardId }
      );
      await store.forgetCard(cardId);
      return out;
    },

    /**
     * Opens a deposit intent and hands back where to pay. Pay it from Robinhood
     * Chain with `payDeposit` from "rhcard", then call `applyDeposit`.
     *
     * The credit lands on OUR account, not the user's — the provider runs one
     * account for everybody, so whose money it is only exists in the store.
     */
    async deposit(owner: string, amountUsd: number, forCardId?: string): Promise<Deposit> {
      assertAmount(amountUsd);
      if (forCardId) await guard(owner, forCardId);

      const { data } = await call<{ data: Deposit }>("/api/external/deposits/create", {
        amount: amountUsd,
        currency: "USDT",
        network: "sol",
      });
      await store.recordDeposit({
        depositId: data.id,
        owner: norm(owner),
        cardId: forCardId ?? null,
        creditUsd: data.credited_on_completion_usd,
      });
      return data;
    },

    /**
     * Call once the payment fills. Two guards here, both load-bearing: the
     * provider is asked whether money actually arrived (funding debits OUR
     * account, so a client saying it landed is not evidence), and claimDeposit
     * flips pending → applied atomically so a retry cannot fund twice.
     */
    async applyDeposit(owner: string, depositId: string) {
      if (!depositId) throw new Error("depositId is required");

      const { data: status } = await call<{ data: DepositStatus }>(
        "/api/external/deposits/status",
        { id: depositId }
      );
      if (!status.credited) throw new Error("Deposit hasn't landed yet");

      const rec = await store.claimDeposit(depositId, norm(owner));
      if (!rec) throw new Error("Deposit already applied or not found");

      // The provider is the authority on what arrived — the figure stored at
      // creation was only ever an estimate made before the money moved.
      const credited = status.credited_amount_usd;
      if (!rec.cardId) return { credited, onCard: 0, funded: null };

      const onCard = netOnCard(credited);
      if (onCard < MIN_USD) {
        await store.releaseDeposit(depositId);
        throw new Error("Too little left to fund a card after fees");
      }
      try {
        const out = await fund(rec.cardId, onCard);
        return { credited, onCard, funded: out.data };
      } catch (e) {
        // Credited but not delivered — put it back so the user can retry,
        // rather than losing the deposit to a row marked applied.
        await store.releaseDeposit(depositId);
        throw e;
      }
    },
  };
}

export type Cards = ReturnType<typeof createCards>;
