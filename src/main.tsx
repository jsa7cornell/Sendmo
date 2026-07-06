import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.tsx'
import CrashScreen from './components/CrashScreen.tsx'
import { initMonitoring } from './lib/monitoring.ts'

initMonitoring()

// The boundary is ALWAYS on (deliberate pre-flip behavior change — proposal
// review B2): a render crash shows CrashScreen instead of a white page even
// with monitoring env vars unset. Verified: with no Sentry.init,
// Sentry.ErrorBoundary's captureException call is a safe no-op, so this
// degrades to a plain React boundary (inert contract holds).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<CrashScreen />}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
