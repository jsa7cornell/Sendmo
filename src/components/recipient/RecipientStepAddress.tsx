import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle } from "lucide-react";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
