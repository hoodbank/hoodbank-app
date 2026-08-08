"use client";

// Client half of server-auth.ts: attaches the Privy access token so the route
// can verify who is calling instead of taking the caller's word for it.

import { useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";

export function useAuthedFetch() {
  const { getAccessToken } = usePrivy();

  return useCallback(
    async <T,>(body: unknown): Promise<T> => {
      const token = await getAccessToken();
      if (!token) throw new Error("You're signed out — sign in and try again");

      const res = await fetch("/api/cards", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // Routes answer JSON either way; a non-JSON body means something upstream
      // broke, and the status is the only honest thing left to report.
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
      return json as T;
    },
    [getAccessToken]
  );
}
