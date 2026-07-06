// ErrorBoundary fallback (PRE-LAUNCH T1-3). Rendered by the Sentry.ErrorBoundary
// in main.tsx when a render crash escapes React — replaces the white screen.
// Error details go to Sentry (when enabled), never to the user.

export default function CrashScreen() {
    return (
        <div className="min-h-screen bg-background flex items-center justify-center px-4">
            <div className="bg-card rounded-2xl border border-border shadow-sm p-8 max-w-md w-full text-center">
                <h1 className="text-xl font-semibold text-foreground mb-2">Something went wrong</h1>
                <p className="text-muted-foreground mb-6">
                    An unexpected error occurred. Reloading the page usually fixes it.
                </p>
                <button
                    onClick={() => window.location.reload()}
                    className="w-full rounded-xl shadow-sm bg-primary text-primary-foreground py-2.5 font-medium hover:bg-primary/90 transition-colors"
                >
                    Reload page
                </button>
                <p className="text-sm text-muted-foreground mt-4">
                    Still stuck?{" "}
                    <a className="text-primary hover:underline" href="mailto:support@sendmo.co">
                        Contact support
                    </a>
                </p>
            </div>
        </div>
    );
}
