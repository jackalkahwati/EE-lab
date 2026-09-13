import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { SITE_URL } from "../lib/public-config";
import "./globals.css";

// Display + body: Archivo variable, with the width axis so headlines can sit
// at wdth 88 (semi-condensed) while body stays at 100.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  variable: "--font-archivo",
});

// Instrument face: stats, stage names, spec lists, prices, code.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "FirstLight",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${archivo.variable} ${jetbrainsMono.variable}`}>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
