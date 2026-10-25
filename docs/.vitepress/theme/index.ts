import type { Theme } from "vitepress";
import CopyOrDownloadAsMarkdownButtons from "vitepress-plugin-llms/vitepress-components/CopyOrDownloadAsMarkdownButtons.vue";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";

import PoolDiagram from "./components/PoolDiagram.vue";

import "./style.css";

export default {
  extends: DefaultTheme,
  // The pool diagram fills the hero's image area on the home page.
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-image": () => h(PoolDiagram) }),
  enhanceApp({ app }) {
    app.component("CopyOrDownloadAsMarkdownButtons", CopyOrDownloadAsMarkdownButtons);
    app.component("PoolDiagram", PoolDiagram);
  },
} satisfies Theme;
