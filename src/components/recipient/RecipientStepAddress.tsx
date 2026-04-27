import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle } from "lucide-react";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import type { AddressInput, RecipientPath } from "@/lib/types";

interface Props {
  address: AddressInput;
  email: string;
  path: RecipientPath | null;
  errors: string[];
  tried: boolean;
  onAddressChange: (addr: AddressInput) => void;
  onEmailChange: (email: string) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function RecipientStepAddress({
  address, email, path, errors, tried,
  onAddressChange, onEmailChange, onContinue, onBack,
}: Props) {
  const showErrors = tried && errors.length > 0;
  const { user } = useAuth();
  const prefillAttempted = useRef(false);

  // Silent prefill: when signed-in user lands here with empty fields, populate
  // from their most recent address + profile email. User can edit freely.
  useEffect(() => {
    if (!user || prefillAttempted.current) return;
    if (address.verified || address.street || email) return;
    prefillAttempted.current = true;

    (async () => {
      const [{ data: profile }, { data: recentAddr }] = await Promise.all([
        supabase.from("profiles").select("email, full_name").eq("id", user.id).single(),
        supabase
          .from("addresses")
          .select("name, street1, street2, city, state, zip, is_verified")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (recentAddr) {
        onAddressChange({
          name: recentAddr.name || profile?.full_name || "",
          street: [recentAddr.street1, recentAddr.street2].filter(Boolean).join(", "),
          city: recentAddr.city,
          state: recentAddr.state,
          zip: recentAddr.zip,
          verified: !!recentAddr.is_verified,
        });
      }

      const fillEmail = profile?.email ?? user.email ?? "";
      if (fillEmail) onEmailChange(fillEmail);
    })();
  }, [user, address.verified, address.street, email, onAddressChange, onEmailChange]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground">Where should the package be delivered?</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Enter the destination address and your email
        </p>
      </div>

      {/* Destination address */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <SmartAddressInput
          label="destination"
          value={address}
          onChange={onAddressChange}
          error={tried && !address.verified ? "Select an address from the dropdown" : undefined}
        />
      </div>

      {/* Email */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <label htmlFor="recipient-email" className="text-sm font-medium text-foreground">
          Your email
        </label>
        <Input
          id="recipient-email"
          type="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder="you@example.com"
          className={`mt-1.5 rounded-xl ${
            tried && (!email.trim() || !/^.+@.+\..+$/.test(email.trim()))
              ? "border-destructive"
              : ""
          }`}
        />
        <p className="text-xs text-muted-foreground mt-1.5">
          We'll send shipping updates and your label link to this email
        </p>
      </div>

      {/* Validation summary */}
      <AnimatePresence>
        {showErrors && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3"
          >
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <span className="text-sm font-medium text-destructive">Please fix the following:</span>
            </div>
            <ul className="text-sm text-destructive space-y-0.5 ml-6">
              {errors.map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          Back
        </Button>
        <Button onClick={onContinue} className="flex-1 rounded-xl shadow-sm">
          {path === "full_label" ? "Continue to shipment details" : "Continue to shipping preferences"}
        </Button>
      </div>
    </div>
  );
}
