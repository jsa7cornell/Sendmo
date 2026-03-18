import { motion } from "framer-motion";
import { Package, MapPin, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  recipientName: string;
  recipientLocation: string; // "City, ST" — never the full address
  onContinue: () => void;
}

const HOW_IT_WORKS = [
  { icon: MapPin, text: "Enter your address and describe your package" },
  { icon: Package, text: "Choose a shipping method" },
  { icon: Printer, text: "Print the label and drop off your package" },
];

export default function SenderStepIntro({ recipientName, recipientLocation, onContinue }: Props) {
  return (
    <div className="space-y-8">
      {/* Badge */}
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          <Package className="w-3.5 h-3.5" />
          SendMo Label Link
        </span>
      </div>

      {/* Title */}
      <div className="text-center space-y-3">
        <h1 className="text-2xl font-bold text-foreground">
          You're sending a package to {recipientName}
        </h1>
        {recipientLocation && (
          <p className="text-sm text-muted-foreground">{recipientLocation}</p>
        )}
        <p className="text-muted-foreground text-sm max-w-md mx-auto">
          Enter your details, choose a shipping method, and print a label.{" "}
          <span className="font-medium text-foreground">{recipientName}</span> is covering the shipping cost.
        </p>
      </div>

      {/* How it works */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">How it works</h2>
        <div className="space-y-3">
          {HOW_IT_WORKS.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={i} className="flex items-start gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 shrink-0">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                <p className="text-sm text-foreground pt-1">
                  <span className="font-medium text-muted-foreground mr-1.5">{i + 1}.</span>
                  {step.text}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* CTA */}
      <motion.div whileTap={{ scale: 0.98 }}>
        <Button onClick={onContinue} className="w-full rounded-xl shadow-sm text-base py-5" size="lg">
          Get Started
        </Button>
      </motion.div>
    </div>
  );
}
