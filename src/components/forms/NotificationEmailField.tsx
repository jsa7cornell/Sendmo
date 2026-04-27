import { useState } from "react";
import { Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface Props {
  defaultEmail: string;
  value: string;
  onChange: (email: string) => void;
}

export default function NotificationEmailField({ defaultEmail, value, onChange }: Props) {
  const [editing, setEditing] = useState(value !== defaultEmail && value !== "");
  const display = value || defaultEmail;

  if (!editing) {
    return (
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Notifications go to</p>
          <p className="text-sm text-muted-foreground truncate">{display}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing(true);
            if (!value) onChange(defaultEmail);
          }}
          className="text-sm text-primary hover:underline inline-flex items-center gap-1 shrink-0"
          aria-label="Change notification email"
        >
          <Pencil className="w-3.5 h-3.5" />
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <label htmlFor="notify-email" className="text-sm font-medium text-foreground">
        Notifications go to
      </label>
      <div className="flex gap-2 mt-1.5">
        <Input
          id="notify-email"
          type="email"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={defaultEmail}
          className="rounded-xl flex-1"
        />
        <Button
          variant="outline"
          onClick={() => {
            onChange(defaultEmail);
            setEditing(false);
          }}
          className="rounded-xl shrink-0"
        >
          Reset
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5">
        We'll send shipping updates here
      </p>
    </div>
  );
}
