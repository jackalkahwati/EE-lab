import type { Metadata } from "next";
import "./globals.css";

const siteUrl =
  process.env.APP_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:4400");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "FirstLight Compose — Design a real PCB from a sentence",
  description:
    "FirstLight Compose turns a plain-language description into a manufacturable circuit board, placed, routed, checked, with firmware and a fab package. Start free.",
  openGraph: {
    title: "FirstLight Compose — Design a real PCB from a sentence",
    description:
      "Describe what you're building. Compose places, routes, checks, and hands you a manufacturable fab package plus firmware. Minutes, not weeks.",
    siteName: "FirstLight",
    type: "website",
    images: [
      {
        url: "/media/fl1-front.png",
        width: 1402,
        height: 1122,
        alt: "FirstLight FL-1 autonomous PCB bring-up station",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "FirstLight Compose — Design a real PCB from a sentence",
    description:
      "Describe your board. Compose places, routes, checks, and generates firmware and a fab package.",
    images: ["/media/fl1-front.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
