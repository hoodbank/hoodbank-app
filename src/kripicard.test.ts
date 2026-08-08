// The money paths, and only the money paths: fee arithmetic, the ownership
// guard, and the two ways a deposit can be lost (funded twice, or claimed then
// dropped on a provider error).
//
//   node --test src/kripicard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCards, netOnCard, type CardStore, type DepositRecord } from "./kripicard.ts";

/** In-memory store — for this file only. Real deployments need a database. */
function fakeStore(deposit?: DepositRecord) {
  const owned = new Set<string>();
  const calls: string[] = [];
  let pending = deposit;
  const store: CardStore = {
    async ownsCard(owner, cardId) {
      return owned.has(`${owner}/${cardId}`);
    },
    async recordCard(rec) {
      owned.add(`${rec.owner}/${rec.cardId}`);
      calls.push("recordCard");
    },
    async forgetCard() {
      calls.push("forgetCard");
    },
    async recordDeposit() {
      calls.push("recordDeposit");
    },
    async claimDeposit(_id, owner) {
      calls.push("claimDeposit");
      if (!pending || pending.owner !== owner) return null;
      const won = pending;
      pending = undefined; // atomic flip: only the first caller gets the row
      return won;
    },
    async releaseDeposit() {
      calls.push("releaseDeposit");
      pending = deposit;
    },
  };
  return { store, owned, calls };
}

/** Swaps global fetch for a canned responder and records what was sent. */
function stubFetch(reply: (path: string, body: Record<string, unknown>) => unknown) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push({ path, body });
    return { ok: true, status: 200, json: async () => reply(path, body) };
  }) as unknown as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = real) };
}

test("netOnCard strips the $1 + 4% funding fee and rounds down to cents", () => {
  // $100 credited: (100 - 1) / 1.04 = 95.192307… -> 95.19, and 95.19 * 1.04 + 1
  // is 99.99 <= 100, so the account can actually cover it.
  assert.equal(netOnCard(100), 95.19);
  assert.ok(netOnCard(100) * 1.04 + 1 <= 100);
  // Below the provider's floor once fees are taken.
  assert.ok(netOnCard(11) < 10);
});

test("a card you do not own is not readable, and never reaches the provider", async () => {
  const { store } = fakeStore();
  const f = stubFetch(() => ({ card_number: "4111111111111111" }));
  try {
    const cards = createCards({ apiKey: "k", store });
    await assert.rejects(() => cards.details("0xabc", "card_1"), /Card not found/);
    assert.equal(f.sent.length, 0);
  } finally {
    f.restore();
  }
});

test("a deposit funds a card once, at the post-fee amount", async () => {
  const rec: DepositRecord = {
    depositId: "d1",
    owner: "0xabc",
    cardId: "card_1",
    creditUsd: 99,
  };
  const { store, calls } = fakeStore(rec);
  const f = stubFetch((path) =>
    path.endsWith("/deposits/status")
      ? { data: { credited: true, credited_amount_usd: 100 } }
      : { data: { card_id: "card_1", amount: 95.19 } }
  );
  try {
    const cards = createCards({ apiKey: "k", store });
    const out = await cards.applyDeposit("0xABC", "d1");
    assert.equal(out.onCard, 95.19);
    // The provider's figure wins over the estimate stored at creation ($99).
    assert.equal(out.credited, 100);
    assert.equal(f.sent.at(-1)?.body.amount, 95.19);

    // Second call: the row is already claimed, so no second fundcard goes out.
    const before = f.sent.length;
    await assert.rejects(() => cards.applyDeposit("0xABC", "d1"), /already applied/);
    assert.equal(f.sent.length, before + 1); // the status check, and nothing more
    assert.equal(calls.filter((c) => c === "releaseDeposit").length, 0);
  } finally {
    f.restore();
  }
});

test("a deposit is released, not swallowed, when funding fails", async () => {
  const { store, calls } = fakeStore({
    depositId: "d1",
    owner: "0xabc",
    cardId: "card_1",
    creditUsd: 99,
  });
  const f = stubFetch((path) =>
    path.endsWith("/deposits/status")
      ? { data: { credited: true, credited_amount_usd: 100 } }
      : { success: false, message: "Rate limit exceeded" }
  );
  try {
    const cards = createCards({ apiKey: "k", store });
    // The provider's own message survives — it is the only actionable one.
    await assert.rejects(() => cards.applyDeposit("0xabc", "d1"), /Rate limit exceeded/);
    assert.ok(calls.includes("releaseDeposit"));
    // And the retry now works, so the credit is not stranded.
    assert.ok(await store.claimDeposit("d1", "0xabc"));
  } finally {
    f.restore();
  }
});

test("an uncredited deposit never touches the store", async () => {
  const { store, calls } = fakeStore();
  const f = stubFetch(() => ({ data: { credited: false } }));
  try {
    const cards = createCards({ apiKey: "k", store });
    await assert.rejects(() => cards.applyDeposit("0xabc", "d1"), /hasn't landed/);
    assert.deepEqual(calls, []);
  } finally {
    f.restore();
  }
});
