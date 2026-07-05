import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FirstLight Compose, Design a real PCB from a sentence",
  description:
    "FirstLight Compose turns a plain-language description into a manufacturable circuit board, placed, routed, checked, with firmware and a fab package. Start free.",
  openGraph: {
    title: "FirstLight Compose, Design a real PCB from a sentence",
    description:
      "Describe what you're building. Compose places, routes, checks, and hands you a manufacturable fab package plus firmware. Minutes, not weeks.",
    images: ["/media/fl1-front.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
