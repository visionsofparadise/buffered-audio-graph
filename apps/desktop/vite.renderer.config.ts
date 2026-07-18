import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: {
    'process.platform': JSON.stringify(process.platform),
    'process.arch': JSON.stringify(process.arch),
  },
  server: {
    // The dev-server root is apps/desktop, so the GUI smoke's isolated userData
    // profile falls under the watcher. Its atomic writes (write .tmp → rename)
    // race chokidar and throw an unhandled EBUSY inside Forge that kills the app
    // mid-run. Exclude the smoke profile and seed bag from the watch.
    watch: { ignored: ['**/.smoke-profile/**', '**/.smoke-seed.bag'] },
  },
});
