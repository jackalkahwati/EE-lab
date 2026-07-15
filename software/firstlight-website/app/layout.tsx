import type { Metadata } from "next";
import "./globals.css";

const siteUrl =
  process.env.APP_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:4400");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "FirstLight Compose — Design a real product from a sentence",
  description:
    "FirstLight Compose turns a plain-language description into a manufacturable product: a routed, DRC-gated board, a fit-checked enclosure, real physics simulation, firmware, and the manufacturing, sourcing, and test plans to build it. Start free.",
  openGraph: {
    title: "FirstLight Compose — Design a real product from a sentence",
    description:
      "Describe what you're building. Compose designs the board, the enclosure that fits it, the firmware, and the plans to manufacture, source, and test it. About seven minutes, end to end.",
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
    title: "FirstLight Compose — Design a real product from a sentence",
    description:
      "Describe your product. Compose designs the board, enclosure, firmware, and the plans to build it — gated on real checks.",
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
