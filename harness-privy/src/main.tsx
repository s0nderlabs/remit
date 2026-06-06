import React from "react";
import ReactDOM from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { App } from "./App";
import { PRIVY_APP_ID, PRIVY_CLIENT_ID } from "./config";

// PrivyProvider config. Key shapes verified against the installed
// @privy-io/react-auth@3.29.2 types (see README "discrepancies vs research"):
//  - embeddedWallets.ethereum.createOnLogin: 'all-users'
//  - embeddedWallets.showWalletUIs: false  (sibling of `ethereum`, silent signing)
//  - loginMethods is a flat string array
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID}
      config={{
        loginMethods: ["email", "google"],
        embeddedWallets: {
          ethereum: { createOnLogin: "all-users" },
          showWalletUIs: false,
        },
      }}
    >
      <App />
    </PrivyProvider>
  </React.StrictMode>,
);
