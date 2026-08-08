// USD → display-currency rate, proxied server-side.
//
// The browser used to call Frankfurter directly and something on the client —
// an ad-blocker, an extension, a stale CSP — kept eating the request. A
// same-origin endpoint is immune to all of that, and the server fetch is the
// path that provably works. Rates are ECB daily fixes, so an hour of caching
// loses nothing.

export const runtime = "nodejs";

const ALLOWED = new Set(["IDR", "JPY", "EUR", "GBP"]);

export async function GET(req: Request) {
  const to = new URL(req.url).searchParams.get("to") ?? "";
  if (!ALLOWED.has(to)) {
    return Response.json({ error: "Unsupported currency" }, { status: 400 });
  }
  try {
    const r = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${to}`, {
      next: { revalidate: 3600 },
    });
    const j = (await r.json()) as { rates?: Record<string, number> };
    const rate = j?.rates?.[to];
    if (!rate) throw new Error("no rate in response");
    return Response.json({ rate });
  } catch {
    return Response.json({ error: "Rate source unavailable" }, { status: 502 });
  }
}
