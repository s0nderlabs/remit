import type { Metadata } from "next";
import { Funnel_Display, Sora } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// The settled type system, two voices only: Funnel Display (headlines, wordmark,
// display numerals) and Sora (everything else — UI, data, hex). The mono and
// serif voices were cut; .data/.mono class names survive on the Sora stack.
const display = Funnel_Display({ weight: ["500", "600"], subsets: ["latin"], variable: "--font-display" });
const sans = Sora({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "remit · cards",
  description: "the card issuer for agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
