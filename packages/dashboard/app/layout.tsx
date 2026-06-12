import type { Metadata, Viewport } from "next";
import { Funnel_Display, Sora } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// The settled type system, two voices only: Funnel Display (headlines, wordmark,
// display numerals) and Sora (everything else · UI, data, hex). The mono and
// serif voices were cut; .data/.mono class names survive on the Sora stack.
const display = Funnel_Display({ weight: ["500", "600"], subsets: ["latin"], variable: "--font-display" });
const sans = Sora({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "remit · cards",
  description: "the card issuer for agents",
};

// Mobile correctness: explicit viewport (edge-to-edge on notched phones). The
// input-focus zoom on iOS is prevented at the CSS layer (16px controls on
// coarse pointers), so the viewport stays user-scalable. theme-color is OWNED
// by the inline theme script + the toggle (the app theme is the user's saved
// choice, not the OS preference · a static media-keyed meta would tint the
// browser chrome wrong for pinned themes).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Theme lands on <html> before first paint: saved choice wins, OS preference
// seeds the first visit. Runs inline so dark mode never flashes light. Also
// pins the theme-color meta (browser chrome tint) to the ACTIVE theme · the
// toggle keeps it in sync afterwards.
const themeInit = `(function(){var t="light";try{t=localStorage.getItem("remit-theme");if(t!=="dark"&&t!=="light"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}}catch(e){t="light";}document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement("meta");m.setAttribute("name","theme-color");document.head.appendChild(m);}m.setAttribute("content",t==="dark"?"#141417":"#f7f7f8");})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
