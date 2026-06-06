import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "remit",
  description: "the card issuer for agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="top">
            <span className="logo">remit</span>
            <span className="tag">the card issuer for agents · dev dashboard</span>
          </header>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
