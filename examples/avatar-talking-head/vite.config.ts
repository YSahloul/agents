import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    // The SFU dials this dev server for WebSocket-ingest tracks, so the dev
    // server has to answer on a publicly routable hostname. Vite rejects
    // unknown Host headers, which shows up as a WebSocket handshake failure
    // from the SFU (`websocket_handshake_failed`) rather than a local error.
    // See the README for the tunnel recipe.
    allowedHosts: [".trycloudflare.com", ".cloudflareaccess.com"]
  }
});
