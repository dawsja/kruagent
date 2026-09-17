import type { MetadataRoute } from "next";

/** Self-hosted instances are private; ask crawlers to stay out. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
