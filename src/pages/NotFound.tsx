import { motion } from "framer-motion";
import { Package, ArrowLeft, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import AppHeader from "@/components/AppHeader";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex flex-col">
      <AppHeader />

      <div className="flex-1 flex items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="w-full max-w-sm text-center"
        >
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
            <Package className="w-8 h-8 text-primary" />
          </div>

          <h1 className="text-3xl font-bold text-foreground mb-2">Lost in transit</h1>
          <p className="text-muted-foreground mb-8 leading-relaxed">
            This page doesn't exist — or it may have moved. Let's get you back on track.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              className="rounded-xl gap-2"
              onClick={() => window.location.href = "/"}
            >
              <Home className="w-4 h-4" />
              Go home
            </Button>
            <Button
              variant="outline"
              className="rounded-xl gap-2"
              onClick={() => history.back()}
            >
              <ArrowLeft className="w-4 h-4" />
              Go back
            </Button>
          </div>

          <p className="text-xs text-muted-foreground mt-10">Error 404</p>
        </motion.div>
      </div>
    </div>
  );
}
