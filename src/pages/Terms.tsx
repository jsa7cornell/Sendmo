export default function Terms() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-10 prose prose-sm">
      <h1 className="text-2xl font-bold text-foreground mb-2">Terms of Service</h1>
      <p className="text-xs text-muted-foreground mb-6">Last updated: May 10, 2026</p>

      <div className="space-y-4 text-sm text-foreground leading-relaxed">
        <p>
          By using SendMo you agree to these terms. We try to keep them short and fair.
        </p>

        <h2 className="text-base font-semibold mt-6">What SendMo does</h2>
        <p>
          SendMo lets you generate prepaid shipping labels and share links so others can send
          you packages with shipping pre-paid. The actual shipping is performed by carriers
          (USPS, UPS, etc.) via EasyPost.
        </p>

        <h2 className="text-base font-semibold mt-6">Your account</h2>
        <p>
          You're responsible for the accuracy of the information you provide (addresses,
          contents, weight) and for keeping your account credentials safe.
        </p>

        <h2 className="text-base font-semibold mt-6">Payments and refunds</h2>
        <p>
          You'll be charged the displayed shipping price when a label is generated. If a label
          isn't used and is voided, the carrier may issue a refund through SendMo — refund
          timing depends on the carrier (typically 1–4 weeks).
        </p>

        <h2 className="text-base font-semibold mt-6">Prohibited items</h2>
        <p>
          You agree not to ship anything prohibited by the carrier (hazardous materials,
          firearms, illegal goods, etc.). Carrier rules govern; SendMo isn't liable for
          carrier-imposed penalties.
        </p>

        <h2 className="text-base font-semibold mt-6">Liability</h2>
        <p>
          SendMo is provided as-is. For lost or damaged packages, our liability is limited to
          the cost of the label. Carrier insurance (where available) covers package value.
        </p>

        <h2 className="text-base font-semibold mt-6">Changes</h2>
        <p>
          We may update these terms; we'll note the date at the top. Continued use means you
          accept the updates.
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
