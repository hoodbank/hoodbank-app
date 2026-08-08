// Server-side identity for API routes.
//
// The demo used to take the owner address straight from the request body. That
// is survivable for public data and nothing else: the moment a route can return
// a card number or move money, an address off the wire means anyone can pass
// anyone else's. So the client sends its Privy access token, we verify it
// against Privy, and the route learns who is calling from a source the caller
// cannot forge.
//
// Returns the wallet ADDRESS, not the Privy user id — card ownership is keyed
// by address throughout, and so is everything on Robinhood Chain.

import { PrivyClient } from "@privy-io/server-auth";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;

let client: PrivyClient | null = null;
function privy(): PrivyClient {
  if (!APP_ID || !APP_SECRET) throw new Error("Privy server auth is not configured");
  client ??= new PrivyClient(APP_ID, APP_SECRET);
  return client;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** `Authorization: Bearer <privy access token>` */
function bearer(req: Request): string {
  const [scheme, token] = (req.headers.get("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) throw new AuthError("Missing bearer token");
  return token;
}

/**
 * Verifies the caller and returns their embedded wallet address, lowercased.
 *
 * Throws AuthError on anything suspect, and the caller should turn that into a
 * 401 and nothing else. Never fall back to an address from the request body —
 * that is the exact hole this closes.
 */
export async function requireWallet(req: Request): Promise<string> {
  const token = bearer(req);

  // Resolved outside the try on purpose: a missing app secret caught in there
  // would surface as "invalid session" and send whoever is debugging it hunting
  // a login bug that does not exist.
  const p = privy();

  let userId: string;
  try {
    ({ userId } = await p.verifyAuthToken(token));
  } catch {
    throw new AuthError("Invalid or expired session");
  }

  const accounts = (await p.getUser(userId)).linkedAccounts ?? [];

  // Ethereum specifically, not "the first wallet". A Privy account can carry a
  // Solana embedded wallet too and it is often listed first, which would key
  // card ownership to an address Robinhood Chain has never heard of.
  const isEvmWallet = (a: unknown): a is { address: string } =>
    (a as { type?: string }).type === "wallet" &&
    typeof (a as { address?: string }).address === "string" &&
    ((a as { chainType?: string }).chainType === "ethereum" ||
      (a as { address: string }).address.startsWith("0x"));

  const wallet =
    accounts.find(
      (a) => isEvmWallet(a) && (a as { walletClientType?: string }).walletClientType === "privy"
    ) ?? accounts.find(isEvmWallet);

  if (!wallet) throw new AuthError("No Ethereum wallet on this account");
  return (wallet as { address: string }).address.toLowerCase();
}

/** Turns an AuthError into a 401 and anything else into a 500. */
export function authErrorResponse(e: unknown): Response {
  if (e instanceof AuthError) return Response.json({ error: e.message }, { status: 401 });
  return Response.json({ error: "Server error" }, { status: 500 });
}
