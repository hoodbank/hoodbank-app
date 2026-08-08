"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { robinhoodChain } from "../src/pay";

const config = {
  // Google has to be enabled in the Privy dashboard as well as listed here —
  // listing it alone renders a button that fails on click.
  loginMethods: ["email", "google", "wallet"] as const,
  appearance: {
    walletChainType: "ethereum-only" as const,
    landingHeader: "HoodBank",
    loginMessage: "Pay anything on Robinhood Chain",
    logo: "/logo.png",
  },
  // An embedded wallet for everyone: card ownership is keyed by address, so a
  // user without one has nothing to own a card with.
  embeddedWallets: { ethereum: { createOnLogin: "all-users" as const } },
  defaultChain: robinhoodChain,
  // Must list every chain the app will switchChain to, or Privy rejects the
  // call. The payment leg originates on Robinhood Chain and stays there, so
  // this is the whole list — add funding origins here if money ever comes in
  // from another chain.
  supportedChains: [robinhoodChain],
};

export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  // No app ID (first deploy, before env is set): render without Privy so the
  // build can still prerender. Nothing will authenticate until it is set.
  if (!appId) return <>{children}</>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (
    <PrivyProvider appId={appId} config={config as any}>
      {children}
    </PrivyProvider>
  );
}
