import AppHeader from "@/components/AppHeader";
import SiteFooter from "@/components/SiteFooter";

export default function FAQ() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex flex-col">
      <AppHeader />

      <main className="flex-1 container max-w-2xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-bold text-foreground mb-2">FAQ</h1>
        <p className="text-sm text-muted-foreground">
          Answers are on their way. In the meantime, email{" "}
          <a className="text-primary hover:underline" href="mailto:support@sendmo.co">support@sendmo.co</a>{" "}
          and we\'ll help.
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}
