"use client";

// Privy provider. Config shape verified against @privy-io/react-auth@3.29.2 (the
// proven Phase-C harness): embeddedWallets.ethereum.createOnLogin 'all-users' +
// showWalletUIs:false (silent signing; the issuance ceremony is the only sheet, and
// we keep it silent in v1 per the locked UX). Base mainnet only.

import { PrivyProvider } from "@privy-io/react-auth";
import { MotionConfig } from "motion/react";
import { base } from "viem/chains";
import { PRIVY_APP_ID, PRIVY_CLIENT_ID } from "@/lib/chain";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID}
      config={{
        loginMethods: ["email", "google"],
        embeddedWallets: {
          ethereum: { createOnLogin: "all-users" },
          showWalletUIs: false,
        },
        defaultChain: base,
        supportedChains: [base],
        appearance: { theme: "light", accentColor: "#1f6feb" },
      }}
    >
      {/* motion respects the OS reduced-motion preference everywhere */}
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </PrivyProvider>
  );
}
