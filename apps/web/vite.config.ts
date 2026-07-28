import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    solid(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["brand-mark.svg", "apple-touch-icon.png", "brand-concept.png"],
      manifest: {
        name: "Tally",
        short_name: "Tally",
        description: "Shared fairly. Reconciled clearly.",
        theme_color: "#f8f7f4",
        background_color: "#f8f7f4",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        cleanupOutdatedCaches: true,
        globPatterns: ["**/*.{js,css,html,svg,png,webp}"],
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
