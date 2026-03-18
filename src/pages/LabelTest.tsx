import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

const BASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;


// ─── Types ───────────────────────────────────────────────────

import AddressFields from "@/components/ui/AddressFields";
import type { AddressInput } from "@/lib/types";

// ... existing code ...
// I will rewrite this to use multi_replace since I need to also add imports properly. I'll pass on this exact one and use a better chunk.
interface ParcelInput {
    length: string;
    width: string;
    height: string;
    weightLbs: string;
    weightOz: string;
    packaging: "box" | "envelope" | "tube";
}

interface Rate {
    carrier: string;
    service: string;
    display_price: number;
    delivery_days: number | null;
    easypost_shipment_id: string;
    easypost_rate_id: string;
}

interface LabelResult {
    tracking_number: string;
    carrier: string;
    service: string;
    label_url: string;
}

// ─── Animation variants ─────────────────────────────────────

const stepVariants = {
    initial: { opacity: 0, x: 20 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -20 },
};

// ─── Carrier display name normalization ──────────────────────

const CARRIER_NAMES: Record<string, string> = {
    // UPS variants
    UPSDAP: "UPS",
    UPS: "UPS",
    UPSMI: "UPS Mail Innovations",
    // FedEx variants
    FedExDefault: "FedEx",
    FedEx: "FedEx",
    FEDEX: "FedEx",
    FedExSmartPost: "FedEx Smart Post",
    // USPS variants
    USPS: "USPS",
    // DHL variants
    DhlEcs: "DHL eCommerce",
    DHLExpress: "DHL Express",
    DHL: "DHL",
    // Misc
    CanadaPost: "Canada Post",
    USAExportPBA: "USPS Export",
    Lasership: "LaserShip",
    OnTrac: "OnTrac",
};

function carrierDisplayName(raw: string): string {
    return CARRIER_NAMES[raw] ?? raw;
}

// Cleans up ALL_CAPS_UNDERSCORE service names to Title Case
function serviceDisplayName(raw: string): string {
    return raw
        .replace(/_/g, " ")
        .replace(/\b(\w)/g, (c) => c.toUpperCase());
}

// ─── Helpers ─────────────────────────────────────────────────

const emptyAddress = (): AddressInput => ({
    name: "",
    street: "",
    city: "",
    state: "",
    zip: "",
});

const defaultParcel = (): ParcelInput => ({
    length: "",
    width: "",
    height: "",
    weightLbs: "",
    weightOz: "",
    packaging: "box",
});



// ─── Spinner component ──────────────────────────────────────

function Spinner({ size = "sm" }: { size?: "sm" | "lg" }) {
    const dim = size === "lg" ? "w-8 h-8" : "w-4 h-4";
    return (
        <svg
            className={`${dim} animate-spin text-primary`}
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
        >
            <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
            />
            <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
        </svg>
    );
}

// ─── Component ───────────────────────────────────────────────

export default function LabelTest() {
    const [sessionId] = useState(() => crypto.randomUUID());
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Live mode toggle
    const [liveMode, setLiveMode] = useState(false);

    // State 1 – Addresses
    const [fromAddr, setFromAddr] = useState<AddressInput>(emptyAddress());
    const [toAddr, setToAddr] = useState<AddressInput>(emptyAddress());
    const [fromErrors, setFromErrors] = useState<Partial<Record<keyof AddressInput, string>>>({});
    const [toErrors, setToErrors] = useState<Partial<Record<keyof AddressInput, string>>>({});
    const [verifiedAddresses, setVerifiedAddresses] = useState<{
        from_id: string;
        to_id: string;
        from_address: Record<string, unknown>;
        to_address: Record<string, unknown>;
    } | null>(null);

    // State 2 – Package
    const [parcel, setParcel] = useState<ParcelInput>(defaultParcel());

    // State 3 – Rates
    const [rates, setRates] = useState<Rate[]>([]);
    const [rateMessages, setRateMessages] = useState<string[]>([]);

    // State 4 – Label
    const [labelResult, setLabelResult] = useState<LabelResult | null>(null);

    // ─── API calls ─────────────────────────────────────────────

    async function verifyAddresses() {
        setLoading(true);
        setError(null);
        setFromErrors({});
        setToErrors({});

        // ── Client-side check: require Google-verified selections ──
        let clientBlocked = false;
        if (!fromAddr.verified) {
            setFromErrors({ street: "Please select an address from the dropdown to verify it" });
            clientBlocked = true;
        }
        if (!toAddr.verified) {
            setToErrors({ street: "Please select an address from the dropdown to verify it" });
            clientBlocked = true;
        }
        if (clientBlocked) {
            setLoading(false);
            return;
        }

        // ── Client-side check: sender and recipient cannot be the same address ──
        const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
        const fromKey = [fromAddr.street, fromAddr.city, fromAddr.state, fromAddr.zip].map(normalize).join("|");
        const toKey = [toAddr.street, toAddr.city, toAddr.state, toAddr.zip].map(normalize).join("|");
        if (fromKey === toKey) {
            setToErrors({ street: "Recipient address cannot be the same as the sender address" });
            setLoading(false);
            return;
        }

        try {
            const res = await fetch(`${BASE_URL}/functions/v1/addresses`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Session-ID": sessionId,
                    "Authorization": `Bearer ${ANON_KEY}`
                },
                body: JSON.stringify({
                    live_mode: liveMode,
                    from: {
                        name: fromAddr.name,
                        street1: fromAddr.street,
                        city: fromAddr.city,
                        state: fromAddr.state,
                        zip: fromAddr.zip,
                        country: "US",
                        place_id: fromAddr.place_id,
                        google_verified: true,
                    },
                    to: {
                        name: toAddr.name,
                        street1: toAddr.street,
                        city: toAddr.city,
                        state: toAddr.state,
                        zip: toAddr.zip,
                        country: "US",
                        place_id: toAddr.place_id,
                        google_verified: true,
                    },
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                const errResult = {
                    message: body.error || `Address verification failed (${res.status})`,
                    type: body.type,
                    fieldErrors: body.fieldErrors || []
                };
                throw errResult;
            }
            const data = await res.json();
            setVerifiedAddresses(data);
            setStep(2);
        } catch (err: any) {
            if (err && err.fieldErrors && err.fieldErrors.length > 0) {
                const fieldMap: Record<string, keyof AddressInput> = {
                    address: "street",
                    street1: "street",
                    street2: "street",
                    city: "city",
                    state: "state",
                    zip: "zip",
                    zip4: "zip",
                    name: "name"
                };
                const newErrors: Partial<Record<keyof AddressInput, string>> = {};
                for (const fe of err.fieldErrors) {
                    const mappedField = fieldMap[fe.field] || "street";
                    newErrors[mappedField] = fe.message;
                }

                if (err.type === "from") {
                    setFromErrors(newErrors);
                    setError(`From address: ${err.message} (Session ID: ${sessionId})`);
                } else if (err.type === "to") {
                    setToErrors(newErrors);
                    setError(`To address: ${err.message} (Session ID: ${sessionId})`);
                } else {
                    setError(`${err.message} (Session ID: ${sessionId})`);
                }
            } else if (err.type === "from") {
                setFromErrors({ street: err.message });
                setError(`From address: ${err.message} (Session ID: ${sessionId})`);
            } else if (err.type === "to") {
                setToErrors({ street: err.message });
                setError(`To address: ${err.message} (Session ID: ${sessionId})`);
            } else {
                setError(`${err instanceof Error ? err.message : err.message || "Address verification failed"} (Session ID: ${sessionId})`);
            }
        } finally {
            setLoading(false);
        }
    }

    async function getRates() {
        setLoading(true);
        setError(null);
        try {
            const totalOz =
                (parseInt(parcel.weightLbs || "0", 10) * 16) +
                parseInt(parcel.weightOz || "0", 10);

            const res = await fetch(`${BASE_URL}/functions/v1/rates`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Session-ID": sessionId,
                    "Authorization": `Bearer ${ANON_KEY}`
                },
                body: JSON.stringify({
                    live_mode: liveMode,
                    from_address: verifiedAddresses?.from_address,
                    to_address: verifiedAddresses?.to_address,
                    parcel: {
                        length: parseFloat(parcel.length),
                        width: parseFloat(parcel.width),
                        height: parseFloat(parcel.height),
                        weight_oz: totalOz,
                    },
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Failed to get rates (${res.status})`);
            }
            const data = await res.json();
            const fetchedRates = data.rates ?? [];
            const fetchedMessages: string[] = data.messages ?? [];
            setRates(fetchedRates);
            setRateMessages(fetchedMessages);
            if (fetchedRates.length === 0 && fetchedMessages.length > 0) {
                setError(`No rates available. Carrier reasons: ${fetchedMessages.join(" | ")} (Session ID: ${sessionId})`);
            }
            setStep(3);
        } catch (err: unknown) {
            setError(`${err instanceof Error ? err.message : "Failed to get rates"} (Session ID: ${sessionId})`);
        } finally {
            setLoading(false);
        }
    }

    async function purchaseLabel(rate: Rate) {
        setStep(4);
        setLoading(true);
        setError(null);
        try {
            // Data needed by Edge function to construct mock records
            const mockDataPayload = {
                email: "test_label_generator@example.com",
                from_name: fromAddr.name || "Test User",
                to_name: toAddr.name || "Test Recipient",
                rate_cents: (rate.display_price * 100),
                weight_oz: (parseInt(parcel.weightLbs || "0", 10) * 16) + parseInt(parcel.weightOz || "0", 10),
                length_in: parseFloat(parcel.length || "0"),
                width_in: parseFloat(parcel.width || "0"),
                height_in: parseFloat(parcel.height || "0"),
            };

            const res = await fetch(`${BASE_URL}/functions/v1/labels`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Session-ID": sessionId,
                    "Authorization": `Bearer ${ANON_KEY}`
                },
                body: JSON.stringify({
                    live_mode: liveMode,
                    easypost_shipment_id: rate.easypost_shipment_id,
                    easypost_rate_id: rate.easypost_rate_id,
                    from_address: {
                        name: fromAddr.name,
                        street1: fromAddr.street,
                        city: fromAddr.city,
                        state: fromAddr.state,
                        zip: fromAddr.zip,
                        country: "US"
                    },
                    to_address: {
                        name: toAddr.name,
                        street1: toAddr.street,
                        city: toAddr.city,
                        state: toAddr.state,
                        zip: toAddr.zip,
                        country: "US"
                    },
                    parcel: {
                        length_in: parseFloat(parcel.length || "0"),
                        width_in: parseFloat(parcel.width || "0"),
                        height_in: parseFloat(parcel.height || "0"),
                        weight_oz: (parseInt(parcel.weightLbs || "0", 10) * 16) + parseInt(parcel.weightOz || "0", 10),
                    },
                    display_price_cents: Math.round(rate.display_price * 100),
                    mock_data: mockDataPayload,
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Label creation failed (${res.status})`);
            }
            const data = await res.json();
            setLabelResult(data);

            // DB persistence is now handled entirely within the `labels` Edge Function.
            // Both live and test labels are recorded, and is_test/is_live flags are applied automatically.

        } catch (err: unknown) {
            setError(`${err instanceof Error ? err.message : "Label creation failed"} (Session ID: ${sessionId})`);
        } finally {
            setLoading(false);
        }
    }

    function startOver() {
        setStep(1);
        setFromAddr(emptyAddress());
        setToAddr(emptyAddress());
        setFromErrors({});
        setToErrors({});
        setParcel(defaultParcel());
        setRates([]);
        setRateMessages([]);
        setLabelResult(null);
        setError(null);
    }

    // ─── Pre-fill helpers ──────────────────────────────────────

    function prefillAddresses() {
        setFromAddr({
            name: "SendMo HQ",
            street: "388 Townsend St",
            city: "San Francisco",
            state: "CA",
            zip: "94107",
            verified: true,
            place_id: "ChIJbTdNc3GIhYARvOaFQRiqlXc",
        });
        setToAddr({
            name: "Jane Doe",
            street: "149 New Montgomery St",
            city: "San Francisco",
            state: "CA",
            zip: "94105",
            verified: true,
            place_id: "ChIJV7gHPnyAhYARR7eXJGgumUY",
        });
    }

    function prefillParcel() {
        setParcel({
            length: "10",
            width: "10",
            height: "10",
            weightLbs: "10",
            weightOz: "0",
            packaging: "box",
        });
    }



    // ─── Step indicator ────────────────────────────────────────

    const steps = ["Addresses", "Package", "Rates", "Label"];

    // ─── Carrier restrictions from verified address ────────────
    const toAddr_uspsOnly = !!(verifiedAddresses?.to_address as any)?.usps_only;
    const toAddr_isPOBox = !!(verifiedAddresses?.to_address as any)?.is_po_box;
    const toAddr_isMilitary = !!(verifiedAddresses?.to_address as any)?.is_military;
    const toAddr_verificationWarning = (verifiedAddresses?.to_address as any)?.verification_warning as string | null ?? null;

    // Filter rates to only carriers that can deliver to this address type
    const displayableRates = toAddr_uspsOnly
        ? rates.filter(r => (r.carrier as string).toUpperCase().includes("USPS"))
        : rates;

    // ─── Cheapest rate helper ──────────────────────────────────

    const cheapestRateId =
        displayableRates.length > 0
            ? displayableRates.reduce((min, r) =>
                r.display_price < min.display_price ? r : min
            ).easypost_rate_id
            : null;

    // ─── Render ────────────────────────────────────────────────

    return (
        <div className="min-h-screen bg-background py-10 px-4">
            <div className="max-w-xl mx-auto space-y-6">
                {/* Header */}
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                    <div className="text-center sm:text-left space-y-1">
                        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3 justify-center sm:justify-start">
                            Label Test
                            {liveMode && (
                                <Badge variant="destructive" className="uppercase text-[10px]">Live Mode</Badge>
                            )}
                        </h1>
                        <p className="text-sm text-muted-foreground">
                            End-to-end shipping label flow with live Supabase Edge Functions
                        </p>
                    </div>
                    <div className="flex items-center space-x-2 bg-card border border-border px-4 py-2 rounded-xl shadow-sm">
                        <Switch
                            id="live-mode"
                            checked={liveMode}
                            onCheckedChange={setLiveMode}
                            disabled={loading || step > 1}
                        />
                        <Label htmlFor="live-mode" className="font-medium cursor-pointer">
                            Live Mode
                        </Label>
                    </div>
                </div>

                {/* Step indicator */}
                <div className="flex items-center justify-center gap-2">
                    {steps.map((s, i) => (
                        <div key={s} className="flex items-center gap-2">
                            <div
                                className={`
                  w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-colors
                  ${i + 1 === step
                                        ? "bg-primary text-primary-foreground"
                                        : i + 1 < step
                                            ? "bg-primary/20 text-primary"
                                            : "bg-muted text-muted-foreground"
                                    }
                `}
                            >
                                {i + 1 < step ? "✓" : i + 1}
                            </div>
                            {i < steps.length - 1 && (
                                <div
                                    className={`w-8 h-0.5 ${i + 1 < step ? "bg-primary/40" : "bg-muted"
                                        }`}
                                />
                            )}
                        </div>
                    ))}
                </div>

                {/* Error banner */}
                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                    >
                        <p className="font-medium">Error</p>
                        <p>{error}</p>
                    </motion.div>
                )}

                {/* Steps */}
                <AnimatePresence mode="wait">
                    {/* ─── STATE 1: Addresses ─────────────────────────── */}
                    {step === 1 && (
                        <motion.div
                            key="step1"
                            variants={stepVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            transition={{ duration: 0.25 }}
                            className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-5"
                        >
                            <div className="flex items-center justify-between">
                                <h2 className="text-lg font-semibold">Addresses</h2>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={prefillAddresses}
                                    className="rounded-xl text-xs"
                                >
                                    Pre-fill Test Data
                                </Button>
                            </div>

                            <AddressFields
                                label="From"
                                value={fromAddr}
                                onChange={setFromAddr}
                                errors={fromErrors}
                            />
                            <div className="border-t border-border" />
                            <AddressFields
                                label="To"
                                value={toAddr}
                                onChange={setToAddr}
                                errors={toErrors}
                            />

                            <Button
                                onClick={verifyAddresses}
                                disabled={loading}
                                className="w-full rounded-xl shadow-sm"
                            >
                                {loading ? (
                                    <span className="flex items-center gap-2">
                                        <Spinner /> Verifying…
                                    </span>
                                ) : (
                                    "Get Rates"
                                )}
                            </Button>
                        </motion.div>
                    )}

                    {/* ─── STATE 2: Package Details ───────────────────── */}
                    {step === 2 && (
                        <motion.div
                            key="step2"
                            variants={stepVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            transition={{ duration: 0.25 }}
                            className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-5"
                        >
                            <div className="flex items-center justify-between">
                                <h2 className="text-lg font-semibold">Package Details</h2>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={prefillParcel}
                                    className="rounded-xl text-xs"
                                >
                                    Pre-fill Test Data
                                </Button>
                            </div>

                            {/* Dimensions */}
                            <div>
                                <p className="text-sm font-medium mb-2">
                                    Dimensions (inches)
                                </p>
                                <div className="grid grid-cols-3 gap-3">
                                    <div>
                                        <Label htmlFor="length">Length</Label>
                                        <Input
                                            id="length"
                                            type="number"
                                            min="0"
                                            value={parcel.length}
                                            onChange={(e) =>
                                                setParcel({ ...parcel, length: e.target.value })
                                            }
                                            placeholder="0"
                                        />
                                    </div>
                                    <div>
                                        <Label htmlFor="width">Width</Label>
                                        <Input
                                            id="width"
                                            type="number"
                                            min="0"
                                            value={parcel.width}
                                            onChange={(e) =>
                                                setParcel({ ...parcel, width: e.target.value })
                                            }
                                            placeholder="0"
                                        />
                                    </div>
                                    <div>
                                        <Label htmlFor="height">Height</Label>
                                        <Input
                                            id="height"
                                            type="number"
                                            min="0"
                                            value={parcel.height}
                                            onChange={(e) =>
                                                setParcel({ ...parcel, height: e.target.value })
                                            }
                                            placeholder="0"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Weight */}
                            <div>
                                <p className="text-sm font-medium mb-2">Weight</p>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <Label htmlFor="weight-lbs">Pounds (lbs)</Label>
                                        <Input
                                            id="weight-lbs"
                                            type="number"
                                            min="0"
                                            value={parcel.weightLbs}
                                            onChange={(e) =>
                                                setParcel({ ...parcel, weightLbs: e.target.value })
                                            }
                                            placeholder="0"
                                        />
                                    </div>
                                    <div>
                                        <Label htmlFor="weight-oz">Ounces (oz)</Label>
                                        <Input
                                            id="weight-oz"
                                            type="number"
                                            min="0"
                                            max="15"
                                            value={parcel.weightOz}
                                            onChange={(e) =>
                                                setParcel({ ...parcel, weightOz: e.target.value })
                                            }
                                            placeholder="0"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Packaging type */}
                            <div>
                                <p className="text-sm font-medium mb-2">Packaging</p>
                                <div className="grid grid-cols-3 gap-3">
                                    {(["box", "envelope", "tube"] as const).map((type) => (
                                        <button
                                            key={type}
                                            onClick={() =>
                                                setParcel({ ...parcel, packaging: type })
                                            }
                                            className={`
                        rounded-xl border py-2.5 text-sm font-medium capitalize transition-colors
                        ${parcel.packaging === type
                                                    ? "border-primary bg-primary/5 text-primary"
                                                    : "border-border bg-card text-foreground hover:border-primary/40"
                                                }
                      `}
                                        >
                                            {type === "box"
                                                ? "📦 Box"
                                                : type === "envelope"
                                                    ? "✉️ Envelope"
                                                    : "📜 Tube"}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="flex gap-3">
                                <Button
                                    variant="outline"
                                    onClick={() => setStep(1)}
                                    className="rounded-xl"
                                >
                                    Back
                                </Button>
                                <Button
                                    onClick={getRates}
                                    disabled={loading}
                                    className="flex-1 rounded-xl shadow-sm"
                                >
                                    {loading ? (
                                        <span className="flex items-center gap-2">
                                            <Spinner /> Getting Rates…
                                        </span>
                                    ) : (
                                        "See Rates"
                                    )}
                                </Button>
                            </div>
                        </motion.div>
                    )}

                    {/* ─── STATE 3: Rate Selection ────────────────────── */}
                    {step === 3 && (
                        <motion.div
                            key="step3"
                            variants={stepVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            transition={{ duration: 0.25 }}
                            className="space-y-4"
                        >
                            <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
                                <div className="flex items-center justify-between mb-4">
                                    <h2 className="text-lg font-semibold">Select a Rate</h2>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setStep(2)}
                                        className="rounded-xl text-xs"
                                    >
                                        Back
                                    </Button>
                                </div>

                                {loading ? (
                                    <div className="flex flex-col items-center py-10 gap-3">
                                        <Spinner size="lg" />
                                        <p className="text-sm text-muted-foreground">
                                            Fetching rates…
                                        </p>
                                    </div>
                                ) : displayableRates.length === 0 ? (
                                    <div className="py-6 space-y-2 text-center">
                                        <p className="text-sm text-muted-foreground">No rates available.</p>
                                        {rateMessages.length > 0 && (
                                            <ul className="text-xs text-destructive space-y-1 text-left">
                                                {rateMessages.map((m, i) => (
                                                    <li key={i}>• {m}</li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {/* Carrier restriction advisory */}
                                        {toAddr_uspsOnly && (
                                            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 flex items-start gap-2">
                                                <span className="mt-0.5 shrink-0">📬</span>
                                                <span>
                                                    {toAddr_isPOBox
                                                        ? "This is a PO Box address — only USPS can deliver here. UPS and FedEx options are hidden."
                                                        : toAddr_isMilitary
                                                            ? "This is a military (APO/FPO/DPO) address — only USPS is accepted. UPS and FedEx options are hidden."
                                                            : "Only USPS options are available for this address."}
                                                </span>
                                            </div>
                                        )}
                                        {toAddr_verificationWarning && (
                                            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 flex items-start gap-2">
                                                <span className="mt-0.5 shrink-0">⚠️</span>
                                                <span>Carrier database advisory: {toAddr_verificationWarning}</span>
                                            </div>
                                        )}
                                        {displayableRates.map((rate) => (
                                            <div
                                                key={rate.easypost_rate_id}
                                                className={`
                          rounded-xl border p-4 flex items-center justify-between transition-colors
                          ${rate.easypost_rate_id === cheapestRateId
                                                        ? "border-primary bg-primary/5"
                                                        : "border-border hover:border-primary/40"
                                                    }
                        `}
                                            >
                                                <div className="space-y-1">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-semibold text-sm">
                                                            {carrierDisplayName(rate.carrier as string)}
                                                        </span>
                                                        {rate.easypost_rate_id === cheapestRateId && (
                                                            <Badge className="bg-success text-white border-0 text-[10px] px-1.5 py-0">
                                                                Best Value
                                                            </Badge>
                                                        )}
                                                    </div>
                                                    <p className="text-sm text-muted-foreground">
                                                        {serviceDisplayName(rate.service as string)}
                                                    </p>
                                                    {rate.delivery_days != null && (
                                                        <p className="text-xs text-muted-foreground">
                                                            Est. {rate.delivery_days} day
                                                            {rate.delivery_days !== 1 ? "s" : ""}
                                                        </p>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-4">
                                                    <motion.span
                                                        animate={{ scale: [1, 1.02, 1] }}
                                                        transition={{ duration: 0.4 }}
                                                        className="text-lg font-bold"
                                                    >
                                                        $
                                                        {rate.display_price.toFixed(2)}
                                                    </motion.span>
                                                    <Button
                                                        size="sm"
                                                        onClick={() => purchaseLabel(rate)}
                                                        className="rounded-xl shadow-sm"
                                                    >
                                                        Select
                                                    </Button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    )}

                    {/* ─── STATE 4: Label Ready ───────────────────────── */}
                    {step === 4 && (
                        <motion.div
                            key="step4"
                            variants={stepVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            transition={{ duration: 0.25 }}
                            className="bg-card rounded-2xl border border-border shadow-sm p-5"
                        >
                            {loading ? (
                                <div className="flex flex-col items-center py-10 gap-3">
                                    <Spinner size="lg" />
                                    <p className="text-sm text-muted-foreground">
                                        Generating label…
                                    </p>
                                </div>
                            ) : error ? (
                                <div className="text-center py-6 space-y-4">
                                    <p className="text-destructive font-medium">
                                        Label creation failed
                                    </p>
                                    <Button
                                        variant="outline"
                                        onClick={() => {
                                            setError(null);
                                            setStep(3);
                                        }}
                                        className="rounded-xl"
                                    >
                                        Go Back
                                    </Button>
                                </div>
                            ) : labelResult ? (
                                <div className="text-center space-y-5 py-4">
                                    <div className="space-y-1">
                                        <div className="w-14 h-14 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-3">
                                            <span className="text-2xl">✅</span>
                                        </div>
                                        <h2 className="text-lg font-semibold">Label Ready!</h2>
                                        <p className="text-sm text-muted-foreground">
                                            Your shipping label has been generated.
                                        </p>
                                    </div>

                                    <div className="bg-muted rounded-xl p-4 space-y-2">
                                        <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
                                            Tracking Number
                                        </p>
                                        <p className="font-mono text-2xl font-bold tracking-wide">
                                            {labelResult.tracking_number}
                                        </p>
                                    </div>

                                    <div className="flex justify-center gap-6 text-sm">
                                        <div>
                                            <p className="text-muted-foreground">Carrier</p>
                                            <p className="font-semibold">
                                                {labelResult.carrier}
                                            </p>
                                        </div>
                                        <div>
                                            <p className="text-muted-foreground">Service</p>
                                            <p className="font-semibold">
                                                {labelResult.service}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-3 pt-2">
                                        <Button
                                            onClick={() =>
                                                window.open(labelResult.label_url, "_blank")
                                            }
                                            className="w-full rounded-xl shadow-sm"
                                        >
                                            View Label
                                        </Button>
                                        <Button
                                            variant="outline"
                                            onClick={startOver}
                                            className="w-full rounded-xl"
                                        >
                                            Start Over
                                        </Button>
                                    </div>
                                </div>
                            ) : null}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}


