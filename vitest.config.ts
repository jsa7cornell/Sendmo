import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
    plugins: [react()],
    test: {
        // node, not jsdom, is the default because it fits the majority: 40 of
        // 66 unit files touch no DOM at all. jsdom construction was by far the
        // largest cost in the suite — 110.7s of aggregate `environment` time
        // against 32.7s actually running tests — and those 40 files paid it for
        // nothing. Files that need a DOM opt in with a
        // `// @vitest-environment jsdom` docblock on line 1.
        //
        // A new component test that forgets the docblock fails immediately with
        // "document is not defined", which is the right failure: loud, one line
        // to fix, and impossible to mistake for a passing test. The inverse
        // default hid the cost silently instead.
        environment: "node",
        globals: true,
        setupFiles: ["./tests/setup.ts"],
        exclude: ["node_modules", "dist", ".idea", ".git", ".cache", ".claude/**", "tests/e2e/**", "tests/integration/**", "_archive/**"],
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
