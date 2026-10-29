import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import type { ReactNode } from "react";
import "./globals.css";

const pixel = localFont({ src: "../fonts/PixelifySans.ttf", variable: "--f-pixel", weight: "400 700", display: "swap" });
const silk = localFont({ src: "../fonts/Silkscreen.ttf", variable: "--f-silk", weight: "400", display: "swap" });

export const metadata: Metadata = {
  title: "Nook — pixel notes with a tiny friend",
  description: "A soft, pixel-flavoured second brain: markdown notes, 3D graph, infinite canvas, AI and a pet companion.",
};
export const viewport: Viewport = { themeColor: "#0d0e10", width: "device-width", initialScale: 1 };

const boot = `try{var p=JSON.parse(localStorage.getItem('nook:prefs')||'{}');document.documentElement.dataset.theme=p.theme||'graphite';if(p.grain===false)document.documentElement.dataset.grain='off'}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="graphite" suppressHydrationWarning className={`${pixel.variable} ${silk.variable}`}>
      <head>
        <Script id="nook-boot" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: boot }} />
      </head>
      <body>
        <div className="backdrop" />
        {children}
        <div className="grain" />
        <div className="noise" />
      </body>
    </html>
  );
}
