import { NextResponse, type NextRequest } from "next/server";

// One deployment serves two faces:
//   hoodbank.org        → the landing page (/home)
//   wallet.hoodbank.org → the wallet app (/)
//
// A rewrite, not a redirect: the marketing page must live at the bare apex URL,
// not bounce visitors to /home. The wallet app stays at "/" so every preview
// URL (*.vercel.app) and localhost keeps opening straight into it.
//
// File is `proxy.ts`, not `middleware.ts` — Next 16 renamed the convention and
// warns on the old name.
export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const isApex = host === "hoodbank.org" || host === "www.hoodbank.org";

  if (isApex && req.nextUrl.pathname === "/") {
    return NextResponse.rewrite(new URL("/home", req.url));
  }
  return NextResponse.next();
}

// Skip static assets and API routes — they must resolve the same on both hosts.
export const config = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
