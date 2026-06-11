import type { Metadata } from "next";
import { Funnel_Display, Sora, IBM_Plex_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// The settled type system: Funnel Display (headlines/wordmark), Sora (UI),
// IBM Plex Mono (ALL data), Instrument Serif (the login brand line only).
const display = Funnel_Display({ weight: ["500", "600"], subsets: ["latin"], variable: "--font-display" });
const sans = Sora({ weight: ["400", "500"], subsets: ["latin"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({ weight: ["400", "500"], subsets: ["latin"], variable: "--font-mono" });
const serif = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-serif",
});

export const metadata: Metadata = {
  title: "remit · cards",
  description: "the card issuer for agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
