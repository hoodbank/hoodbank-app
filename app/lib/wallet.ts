"use client";

// Privy embedded wallet → viem WalletClient, which is what src/pay.ts wants.

import { useMemo } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom, type WalletClient } from "viem";
import { robinhoodChain } from "../../src/pay";

export interface EvmWallet {
  ready: boolean;
  isConnected: boolean;
  address: string | null;
  walletClient: WalletClient | null;
  login: () => void;
  logout: () => void;
}

export function useEvmWallet(): EvmWallet {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();

  // Prefer the embedded wallet; fall back to whatever external one is connected.
  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0] ?? null;
  const address = wallet?.address ?? null;

  const walletClient = useMemo<WalletClient | null>(() => {
    if (!wallet || !address) return null;
    // getEthereumProvider() is async, so a thin lazy transport defers it to the
    // moment of the call rather than making this hook async.
    const transport = custom({
      async request({ method, params }) {
        const provider = await wallet.getEthereumProvider();
        return provider.request({ method, params });
      },
    });
    return createWalletClient({
      account: address as `0x${string}`,
      chain: robinhoodChain,
      transport,
    });
  }, [wallet, address]);

  return { ready, isConnected: authenticated && !!address, address, walletClient, login, logout };
}
