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
  // Privy's embedded wallet throws ("only available over HTTPS") during render
  // on insecure origins · e.g. the dev server opened via a LAN IP on a phone ·
  // which crashes the whole tree into Next's error screen. Refuse to mount the
  // provider there and say why instead. The deliberate SSR/client divergence is
  // confined to origins that are already broken by design.
  if (typeof window !== "undefined" && !window.isSecureContext) return <InsecureOrigin />;
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

function InsecureOrigin() {
  return (
    <main className="narrow" style={{ textAlign: "center" }} data-testid="insecure-origin">
      <h1 style={{ fontSize: 20 }}>This Address Can't Run the Wallet</h1>
      <p
        style={{
          color: "var(--body)",
          fontSize: 13,
          marginTop: 12,
          lineHeight: 1.7,
          maxWidth: 420,
          marginLeft: "auto",
          marginRight: "auto",
        }}
      >
        The page is being served over plain HTTP, which browsers treat as an insecure context · the embedded
        wallet layer needs Web Crypto and can't start here. Open the HTTPS deployment instead, or use
        localhost / an HTTPS tunnel for development.
      </p>
    </main>
  );
}
