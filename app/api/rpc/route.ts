// JSON-RPC proxy for Robinhood Chain.
//
// Exists because rpc.*.chain.robinhood.com is DNS-blocked by some ISPs
// (Indonesian "internet positif" resolves it to a block-page IP), so browsers
// on those networks can never reach it directly. A same-origin call always
// gets through, and the server side — Vercel in production — is unblocked.
//
// EVM_RPC_URL overrides the target for local dev behind such an ISP
// (Blockscout's eth-rpc endpoint rides Cloudflare and stays reachable).

export const runtime = "nodejs";

const TARGET = (process.env.EVM_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com").trim();

export async function POST(req: Request) {
  try {
    const body = await req.text();
    const r = await fetch(TARGET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32000, message: "RPC upstream unreachable" } },
      { status: 502 }
    );
  }
}
