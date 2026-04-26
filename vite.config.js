import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  base: mode === "development" ? "/" : "/AI_Village/",
}));
