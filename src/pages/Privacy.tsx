export default function Privacy() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-10 prose prose-sm">
      <h1 className="text-2xl font-bold text-foreground mb-2">Privacy Policy</h1>
      <p className="text-xs text-muted-foreground mb-6">Last updated: May 10, 2026</p>

      <div className="space-y-4 text-sm text-foreground leading-relaxed">
        <p>
          SendMo helps you send and receive packages. To do that we collect only what we need
          to ship them and bill correctly.
        </p>

        <h2 className="text-base font-semibold mt-6">What we collect</h2>
        <ul className="list-disc list-outside ml-5 space-y-1">
          <li>Your name, email, and shipping addresses (yours and your sender's).</li>
          <li>Package details (size, weight, contents description) you enter for each shipment.</li>
          <li>Payment information, processed by Stripe — we never see your full card number.</li>
          <li>Standard web logs (IP, browser) for security and debugging.</li>
        </ul>

        <h2 className="text-base font-semibold mt-6">How we use it</h2>
        <ul className="list-disc list-outside ml-5 space-y-1">
          <li>To create shipping labels via EasyPost (USPS, UPS, etc.).</li>
          <li>To send you tracking and account emails (via Resend).</li>
          <li>To bill you for shipments.</li>
          <li>To improve the product.</li>
        </ul>

        <h2 className="text-base font-semibold mt-6">Who we share it with</h2>
        <p>
          Only the service providers needed to ship your package: EasyPost (carrier integration),
          Stripe (payments), Supabase (database/auth), Resend (email), Vercel (hosting). We don't
          sell your data and we don't share it for advertising.
        </p>

        <h2 className="text-base font-semibold mt-6">Your data</h2>
        <p>
          You can request deletion of your account and data at any time by emailing{" "}
          <a className="text-primary hover:underline" href="mailto:support@sendmo.co">support@sendmo.co</a>.
        </p>

        <h2 className="text-base font-semibold mt-6">Contact</h2>
        <p>
          Questions? Email{" "}
          <a className="text-primary hover:underline" href="mailto:support@sendmo.co">support@sendmo.co</a>.
        </p>
      </div>
    </main>
  );
}
