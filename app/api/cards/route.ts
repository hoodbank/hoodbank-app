// One handler, action in the body, because every card action needs the same two
// things first: a verified caller, and proof that caller owns the card it named.
// `requireWallet` supplies the first, `createCards` enforces the second.
//
// The owner is never read from the body. That is deliberate and load-bearing:
// cards live under one provider account, so an address off the wire would let
// any caller name any card and read its number back.

import { createCards } from "../../../src/kripicard";
import { store, listCards, pendingDeposits } from "../../store";
import { authErrorResponse, requireWallet } from "../../lib/server-auth";
import { rateLimit } from "../../lib/rate-limit";

// Explicit because the store writes files and the API key must never be bundled
// for the client. (No `dynamic` export: POST handlers are never cached.)
export const runtime = "nodejs";

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

export async function POST(req: Request) {
  const key = process.env.KRIPICARD_API_KEY;
  if (!key) return bad("Set KRIPICARD_API_KEY in .env", 500);

  let owner: string;
  try {
    owner = await requireWallet(req);
  } catch (e) {
    return authErrorResponse(e);
  }

  // Keyed on the verified wallet, not on anything the caller controls.
  const limited = rateLimit(`cards:${owner}`);
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return bad("Malformed request");

  const cards = createCards({ apiKey: key, store });
  const cardId = String(body.cardId ?? "");
  const amount = Number(body.amount);

  try {
    switch (String(body.action ?? "")) {
      case "list":
        return Response.json({
          owner,
          cards: await listCards(owner),
          deposits: await pendingDeposits(owner),
        });

      case "create":
        return Response.json({
          card: await cards.create(owner, {
            bin: String(body.bin ?? ""),
            amount,
            nameOnCard: String(body.nameOnCard ?? ""),
            dateOfBirth: body.dateOfBirth ? String(body.dateOfBirth) : undefined,
            email:
              typeof body.email === "string" && body.email.trim() ? body.email.trim() : undefined,
          }),
        });

      case "details":
        return Response.json({ details: await cards.details(owner, cardId) });

      case "transactions":
        return Response.json(await cards.transactions(owner, cardId));

      case "freeze":
      case "unfreeze":
        return Response.json(
          await cards.setFrozen(owner, cardId, String(body.action) === "freeze")
        );

      case "deposit":
        return Response.json({
          deposit: await cards.deposit(owner, amount, cardId || undefined),
        });

      case "apply-deposit":
        return Response.json(await cards.applyDeposit(owner, String(body.depositId ?? "")));

      default:
        return bad("Unknown action");
    }
  } catch (e) {
    // Provider messages are user-facing on purpose — "Rate limit exceeded,
    // blocked for 7 minutes" beats "Something went wrong" every time.
    return bad((e as Error).message || "Card request failed", 502);
  }
}
