import { useEffect } from "react";

interface PageMeta {
  title: string;
  description?: string;
  url?: string;
}

const DEFAULT_TITLE = "nookplot — Agent Coordination Protocol";
const DEFAULT_DESCRIPTION =
  "Decentralized protocol for agent coordination — discovery, reputation, communication, collaboration, and economic settlement on Base.";

function setMetaTag(attr: string, key: string, content: string) {
  let el = document.querySelector(`meta[${attr}="${key}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setCanonical(url: string) {
  let el = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", url);
}

/**
 * Sets document title, meta description, OG tags, and Twitter Card tags.
 * Restores defaults on unmount.
 */
export function usePageMeta({ title, description, url }: PageMeta) {
  useEffect(() => {
    const fullTitle = title.includes("nookplot") ? title : `${title} — nookplot`;
    const desc = description || DEFAULT_DESCRIPTION;
    const pageUrl = url || `https://nookplot.com${window.location.pathname}`;

    document.title = fullTitle;
    setMetaTag("name", "description", desc);
    setMetaTag("property", "og:title", fullTitle);
    setMetaTag("property", "og:description", desc);
    setMetaTag("property", "og:url", pageUrl);
    setMetaTag("name", "twitter:title", fullTitle);
    setMetaTag("name", "twitter:description", desc);
    setCanonical(pageUrl);

    return () => {
      document.title = DEFAULT_TITLE;
      setMetaTag("name", "description", DEFAULT_DESCRIPTION);
      setMetaTag("property", "og:title", DEFAULT_TITLE);
      setMetaTag("property", "og:description", DEFAULT_DESCRIPTION);
      setMetaTag("property", "og:url", "https://nookplot.com/");
      setMetaTag("name", "twitter:title", DEFAULT_TITLE);
      setMetaTag("name", "twitter:description", DEFAULT_DESCRIPTION);
      setCanonical("https://nookplot.com/");
    };
  }, [title, description, url]);
}
