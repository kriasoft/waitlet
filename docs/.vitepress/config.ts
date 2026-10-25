import { defineConfig } from "vitepress";
import llmstxt, { copyOrDownloadAsMarkdownButtons } from "vitepress-plugin-llms";

import pkg from "../../package.json" with { type: "json" };

const origin = "https://kriasoft.com";
const base = "/waitlet/";
const repo = "https://github.com/kriasoft/waitlet";
// Contributor docs share docs/ with the site but stay unpublished.
const internal = ["adr/**", "product.md"];

/**
 * Public URL of a page. Pages are flat files (`guide/claude-code.md`, never
 * `guide/index.md`), so with cleanUrls only the site root ends with a slash.
 */
const pageUrl = (relativePath: string) =>
  origin + base + relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");

export default defineConfig({
  lang: "en-US",
  title: "Waitlet",
  description: pkg.description,
  base,
  // `/guide/claude-code`, not `.html` or a trailing slash. The host must serve
  // `claude-code.html` for that path without redirecting.
  cleanUrls: true,
  srcExclude: internal,
  // Git timestamps: the "Last updated" line and sitemap <lastmod>.
  lastUpdated: true,
  sitemap: { hostname: origin + base },

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: `${base}logo.svg` }],
    ["meta", { name: "theme-color", content: "#646cff" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Waitlet" }],
  ],

  // Per-page canonical and Open Graph tags; also applied in dev and on client-side navigation.
  transformPageData(pageData) {
    const url = pageUrl(pageData.relativePath);
    const title = pageData.frontmatter.layout === "home" ? "Waitlet" : `${pageData.title} | Waitlet`;
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: pageData.description || pkg.description }],
    );
  },

  markdown: {
    // "Copy page" / "View as Markdown" buttons, rendered by the component registered in theme/index.ts.
    config(md) {
      md.use(copyOrDownloadAsMarkdownButtons);
    },
  },

  vite: {
    // llms.txt, llms-full.txt and a Markdown copy of each page, for agents reading the docs.
    plugins: [llmstxt({ domain: origin, ignoreFiles: internal })],
  },

  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/getting-started", activeMatch: "^/guide/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "^/reference/" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Claude Code", link: "/guide/claude-code" },
          { text: "Superset", link: "/guide/superset" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/reference/cli" },
          { text: "Library", link: "/reference/library" },
        ],
      },
    ],
    // The CLI reference lists commands as h3.
    outline: [2, 3],
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: repo },
      { icon: "npm", link: `https://www.npmjs.com/package/${pkg.name}` },
    ],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
    externalLinkIcon: true,
    footer: { message: "Released under the MIT License.", copyright: "Copyright © 2026 Konstantin Tarkus" },
  },
});
