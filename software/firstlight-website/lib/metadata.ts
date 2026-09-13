import type { Metadata } from "next";
import { SITE_URL } from "./public-config";

export const COMPOSE_IMAGE = {
  url: "/media/compose-hero.jpg",
  width: 1600,
  height: 914,
  alt: "FirstLight Compose workspace with a 3D board and engineering pipeline results",
};

export const FL1_IMAGE = {
  url: "/media/fl1-front.png",
  width: 1402,
  height: 1122,
  alt: "FirstLight FL-1 autonomous PCB bring-up station",
};

export function pageMetadata({
  path,
  title,
  description,
  image = COMPOSE_IMAGE,
}: {
  path: string;
  title: string;
  description: string;
  image?: typeof COMPOSE_IMAGE;
}): Metadata {
  const url = new URL(path, SITE_URL).href;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: "FirstLight",
      type: "website",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: image.url, alt: image.alt }],
    },
  };
}
