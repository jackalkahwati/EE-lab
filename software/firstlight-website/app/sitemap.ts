import type { MetadataRoute } from "next";

import { SITE_URL } from "../lib/public-config";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes = ["", "/fl1", "/developers", "/case-study", "/terms", "/privacy"];
  return routes.map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency: path === "" ? "weekly" : "monthly",
    priority: path === "" ? 1 : 0.7,
  }));
}
