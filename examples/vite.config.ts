import { defineConfig } from "vite";

export default defineConfig({
  // Relative, so the build plays from any path, GitHub Pages' /sparcoon/ included.
  base: "./",
  // three and the runtime land in one chunk of about 650 kB.
  build: { chunkSizeWarningLimit: 800 },
});
