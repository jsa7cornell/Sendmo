---
description: Run the complete test suite (Unit, Integration, E2E)
---

# Run Tests Workflow

This workflow executes the 3-tier testing strategy for the SendMo project.

// turbo-all
1. Run ESLint to catch anti-patterns (like nested components)
`npm run lint`

2. Run Type Checker
`npx tsc -b`

3. Run Unit and Component Tests (Vitest + React Testing Library)
`npm run test:unit`

4. Run E2E Tests headlessly (Playwright)
`npm run test:e2e`

5. (Optional) Run E2E Tests in UI mode for debugging
`npm run test:e2e:ui`
