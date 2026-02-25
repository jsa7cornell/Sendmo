import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
    plugins: [react()],
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: ["./tests/setup.ts"],
        exclude: ["node_modules", "dist", ".idea", ".git", ".cache", "tests/e2e/**", "tests/integration/**", "_archive/**"],
        coverage: {
            provider: 'v8',
        }
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
})
