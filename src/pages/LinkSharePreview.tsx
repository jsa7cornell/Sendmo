import LinkShareCard from "@/components/links/LinkShareCard";

export default function LinkSharePreview() {
  return (
    <main className="min-h-screen bg-muted/30 py-8">
      <div className="max-w-xl mx-auto px-4">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-4 text-center">
          LinkShareCard Preview
        </p>
        <LinkShareCard
          shortCode="fqaYPCvYWS"
          value={{
            speed_preference: "standard",
            preferred_carrier: "any",
            price_cap: 100,
            address: {
              name: "John Anderson",
              street: "123 Main St",
              city: "Brooklyn",
              state: "NY",
              zip: "11201",
              verified: true,
            },
          }}
          onDone={() => alert("Go to dashboard")}
          doneLabel="Go to dashboard"
          onBack={() => alert("Go back")}
        />
      </div>
    </main>
  );
}
