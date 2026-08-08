// Who owns which card, and which deposits are in flight.
//
// The provider has no idea which wallet a card belongs to — that mapping only
// exists here, and it is the only thing standing between a user and someone
// else's card number.
//
// Two adapters, picked by DATABASE_URL:
//  - Postgres (Neon etc.) — the real one. claimDeposit is atomic via
//    `update … where status='pending' returning *`.
//  - JSON file — local dev only. Atomic only because one Node process
//    serialises it, and it REFUSES to run on Vercel: a read-only filesystem
//    would lose cards that were already paid for.

import { promises as fs } from "fs";
import path from "path";
import postgres from "postgres";
import type { CardRecord, CardStore, DepositRecord } from "../src/kripicard";

const DB_URL = process.env.DATABASE_URL;
const sql = DB_URL ? postgres(DB_URL, { prepare: false, max: 1 }) : null;

/* ---------- Postgres ---------- */

let ready: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!sql) return Promise.resolve();
  ready ??= sql`
    create table if not exists cards (
      card_id text primary key,
      owner text not null,
      last4 text not null default '',
      bin text not null default '',
      holder text not null default '',
      created_at timestamptz not null default now()
    )`
    .then(
      () => sql`
        create table if not exists card_deposits (
          deposit_id text primary key,
          owner text not null,
          card_id text,
          credit_usd numeric not null,
          status text not null default 'pending',
          created_at timestamptz not null default now()
        )`
    )
    .then(() => sql`create index if not exists cards_owner_idx on cards (owner)`)
    .then(() => {});
  return ready;
}

/* ---------- JSON file (dev) ---------- */

interface Shape {
  cards: Record<string, CardRecord>;
  deposits: Record<string, DepositRecord & { status: "pending" | "applied" }>;
}

const FILE = path.join(process.cwd(), ".data", "cards.json");
let cache: Shape | null = null;

async function load(): Promise<Shape> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await fs.readFile(FILE, "utf8")) as Partial<Shape>;
    cache = { cards: raw.cards ?? {}, deposits: raw.deposits ?? {} };
  } catch {
    cache = { cards: {}, deposits: {} };
  }
  return cache;
}

async function save(d: Shape): Promise<void> {
  // Refuse, loudly, rather than lose a paid-for card on a read-only FS.
  if (process.env.VERCEL) {
    throw new Error("Card storage needs DATABASE_URL in production");
  }
  cache = d;
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(d, null, 2), "utf8");
}

/* ---------- the CardStore ---------- */

export const store: CardStore = {
  async ownsCard(owner, cardId) {
    if (sql) {
      await ensureTables();
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from cards where card_id = ${cardId} and owner = ${owner}`;
      return !!rows[0]?.n;
    }
    return (await load()).cards[cardId]?.owner === owner;
  },

  async recordCard(rec) {
    if (sql) {
      await ensureTables();
      await sql`
        insert into cards (card_id, owner, last4, bin, holder)
        values (${rec.cardId}, ${rec.owner}, ${rec.last4}, ${rec.bin}, ${rec.holder})
        on conflict (card_id) do nothing`;
      return;
    }
    const d = await load();
    d.cards[rec.cardId] = rec;
    await save(d);
  },

  async forgetCard(cardId) {
    if (sql) {
      await ensureTables();
      await sql`delete from cards where card_id = ${cardId}`;
      return;
    }
    const d = await load();
    delete d.cards[cardId];
    await save(d);
  },

  async recordDeposit(rec) {
    if (sql) {
      await ensureTables();
      await sql`
        insert into card_deposits (deposit_id, owner, card_id, credit_usd)
        values (${rec.depositId}, ${rec.owner}, ${rec.cardId}, ${rec.creditUsd})
        on conflict (deposit_id) do nothing`;
      return;
    }
    const d = await load();
    d.deposits[rec.depositId] = { ...rec, status: "pending" };
    await save(d);
  },

  async claimDeposit(depositId, owner) {
    if (sql) {
      await ensureTables();
      // Atomic: whoever flips pending→applied wins; everyone else gets null.
      const rows = await sql<
        { deposit_id: string; owner: string; card_id: string | null; credit_usd: string }[]
      >`
        update card_deposits set status = 'applied'
        where deposit_id = ${depositId} and status = 'pending' and owner = ${owner}
        returning *`;
      const r = rows[0];
      return r
        ? { depositId: r.deposit_id, owner: r.owner, cardId: r.card_id, creditUsd: Number(r.credit_usd) }
        : null;
    }
    const d = await load();
    const rec = d.deposits[depositId];
    if (!rec || rec.status !== "pending" || rec.owner !== owner) return null;
    rec.status = "applied";
    await save(d);
    return rec;
  },

  async releaseDeposit(depositId) {
    if (sql) {
      await ensureTables();
      await sql`update card_deposits set status = 'pending' where deposit_id = ${depositId}`;
      return;
    }
    const d = await load();
    const rec = d.deposits[depositId];
    if (rec) {
      rec.status = "pending";
      await save(d);
    }
  },
};

/* ---------- reads the UI needs (not part of CardStore) ---------- */

export async function listCards(owner: string): Promise<CardRecord[]> {
  if (sql) {
    await ensureTables();
    const rows = await sql<
      { card_id: string; owner: string; last4: string; bin: string; holder: string }[]
    >`select * from cards where owner = ${owner} order by created_at desc`;
    return rows.map((r) => ({
      cardId: r.card_id,
      owner: r.owner,
      last4: r.last4,
      bin: r.bin,
      holder: r.holder,
    }));
  }
  return Object.values((await load()).cards).filter((c) => c.owner === owner);
}

export async function pendingDeposits(owner: string): Promise<DepositRecord[]> {
  if (sql) {
    await ensureTables();
    const rows = await sql<
      { deposit_id: string; owner: string; card_id: string | null; credit_usd: string }[]
    >`select * from card_deposits where owner = ${owner} and status = 'pending'
      order by created_at desc`;
    return rows.map((r) => ({
      depositId: r.deposit_id,
      owner: r.owner,
      cardId: r.card_id,
      creditUsd: Number(r.credit_usd),
    }));
  }
  const d = await load();
  return Object.values(d.deposits).filter((r) => r.owner === owner && r.status === "pending");
}
