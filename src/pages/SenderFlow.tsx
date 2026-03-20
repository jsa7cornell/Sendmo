import { useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import AppHeader from "@/components/AppHeader";

export default function SenderFlow() {
  const { shortCode } = useParams<{ shortCode: string }>();

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex flex-col">
      <AppHeader />

      <main className="flex-1 flex items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="w-full max-w-sm text-center"
        >
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
            <Clock className="w-8 h-8 text-primary" />
          </div>

          <h1 className="text-2xl font-bold text-foreground mb-2">
            Sender checkout coming soon
          </h1>
          <p className="text-muted-foreground mb-6 leading-relaxed">
            {shortCode
              ? `Someone shared this link with you. The sender checkout flow is on its way — check back shortly.`
              : "The sender checkout flow is on its way — check back shortly."}
          </p>

          <Button
            variant="outline"
            className="rounded-xl"
            onClick={() => window.location.href = "/"}
          >
            Back to SendMo
          </Button>
        </motion.div>
      </main>
    </div>
  );
}
