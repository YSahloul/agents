import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

const reactPath = fileURLToPath(new URL("./node_modules/react", import.meta.url));
const reactDomPath = fileURLToPath(
  new URL("./node_modules/react-dom", import.meta.url)
);

export default defineConfig({
  resolve: {
    alias: { react: reactPath, "react-dom": reactDomPath },
    dedupe: ["react", "react-dom"]
  },
  plugins: [agents(), react(), cloudflare(), tailwindcss()]
});
