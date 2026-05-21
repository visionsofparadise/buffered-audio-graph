import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  treeshake: true,
  external: ["react", "react-dom", "@xyflow/react", "lucide-react", "clsx", "tailwind-merge"],
});
