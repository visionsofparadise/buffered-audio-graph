import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: {
    'process.platform': JSON.stringify(process.platform),
    'process.arch': JSON.stringify(process.arch),
  },
});
