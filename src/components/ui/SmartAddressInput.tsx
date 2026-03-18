import { useCallback, useEffect, useRef, useState } from "react";
import type { AddressInput } from "@/lib/types";

// ─── Types ───────────────────────────────────────────────────

const BASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

interface Prediction {
    description: string;
    place_id: string;
    main_text: string;
    secondary_text: string;
}

interface Props {
    label: string;
    value: AddressInput;
    onChange: (v: AddressInput) => void;
    error?: string;
}

// ─── Parse a formatted address string into components ────────

function parseDescriptionToComponents(description: string): Omit<AddressInput, "name" | "verified" | "place_id"> {
    // Format is typically: "123 Main St, City, State ZIP, USA"
    const withoutCountry = description.replace(/, USA$/, "").replace(/, United States$/, "");
    const parts = withoutCountry.split(", ");

    if (parts.length >= 3) {
        const street = parts[0];
        const city = parts[1];
        // last part is usually "State ZIP"
        const stateZip = parts[parts.length - 1].split(" ");
        const state = stateZip[0] || "";
        const zip = stateZip[1] || "";
        return { street, city, state, zip };
    }

    if (parts.length === 2) {
        return { street: parts[0], city: parts[1], state: "", zip: "" };
    }

    return { street: description, city: "", state: "", zip: "" };
}

// ─── Component ───────────────────────────────────────────────

export default function SmartAddressInput({ label, value, onChange, error }: Props) {
    const [query, setQuery] = useState(
        value.verified ? `${value.street}, ${value.city}, ${value.state} ${value.zip}`.trim() : "",
    );
    const [predictions, setPredictions] = useState<Prediction[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isVerified, setIsVerified] = useState(!!value.verified);
    const [activeIndex, setActiveIndex] = useState(-1);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // ── Mirror parent resets ──────────────────────────────────
    useEffect(() => {
        if (!value.street && !value.city) {
            setIsVerified(false);
            setQuery("");
            setPredictions([]);
        }
    }, [value.street, value.city]);

    // ── Sync verified state when parent sets it externally ────
    // (e.g. Pre-fill Test Data button sets verified:true)
    useEffect(() => {
        if (value.verified && value.street) {
            setIsVerified(true);
            setQuery(`${value.street}, ${value.city}, ${value.state} ${value.zip}`.trim());
        } else if (!value.verified && !value.street) {
            setIsVerified(false);
        }
    }, [value.verified, value.street, value.city, value.state, value.zip]);


    // ── Close dropdown on outside click ──────────────────────
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    // ── Fetch predictions from edge function ─────────────────
    const fetchPredictions = useCallback(async (input: string) => {
        if (input.trim().length < 3) {
            setPredictions([]);
            setIsOpen(false);
            return;
        }
        setIsLoading(true);
        try {
            const res = await fetch(`${BASE_URL}/functions/v1/autocomplete`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${ANON_KEY}`,
                },
                body: JSON.stringify({ input }),
            });
            const data = await res.json();
            setPredictions(data.predictions || []);
            setIsOpen((data.predictions || []).length > 0);
        } catch {
            setPredictions([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    // ── Debounced search ──────────────────────────────────────
    function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
        const val = e.target.value;
        setQuery(val);
        setActiveIndex(-1);

        if (isVerified) {
            setIsVerified(false);
            onChange({ ...value, verified: false, place_id: undefined });
        }

        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => fetchPredictions(val), 280);
    }

    // ── User selects from dropdown ────────────────────────────
    async function handleSelect(prediction: Prediction) {
        // Optimistically show the display text while we fetch details
        const fallbackComponents = parseDescriptionToComponents(prediction.description);
        const displayLine = `${fallbackComponents.street}, ${fallbackComponents.city}, ${fallbackComponents.state} ${fallbackComponents.zip}`.trim();
        setQuery(displayLine);
        setIsOpen(false);
        setPredictions([]);
        setIsLoading(true);

        try {
            // Fetch full structured address components (including ZIP) from Google Places Details
            const res = await fetch(`${BASE_URL}/functions/v1/place-details`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${ANON_KEY}`,
                },
                body: JSON.stringify({ place_id: prediction.place_id }),
            });

            if (res.ok) {
                const details = await res.json();
                // Use the Google Places structured components — ZIP is always populated here
                const components = {
                    street: details.street || fallbackComponents.street,
                    city: details.city || fallbackComponents.city,
                    state: details.state || fallbackComponents.state,
                    zip: details.zip || fallbackComponents.zip,
                };
                const finalDisplay = `${components.street}, ${components.city}, ${components.state} ${components.zip}`.trim();
                setQuery(finalDisplay);
                setIsVerified(true);
                onChange({
                    name: value.name,
                    ...components,
                    verified: true,
                    place_id: prediction.place_id,
                });
            } else {
                // Fallback to parsed text if the detail call fails
                setIsVerified(true);
                onChange({
                    name: value.name,
                    ...fallbackComponents,
                    verified: true,
                    place_id: prediction.place_id,
                });
            }
        } catch {
            // Fallback to parsed text on network error
            setIsVerified(true);
            onChange({
                name: value.name,
                ...fallbackComponents,
                verified: true,
                place_id: prediction.place_id,
            });
        } finally {
            setIsLoading(false);
        }
    }

    // ── Keyboard navigation ──────────────────────────────────
    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (!isOpen) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, predictions.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, -1));
        } else if (e.key === "Enter" && activeIndex >= 0) {
            e.preventDefault();
            handleSelect(predictions[activeIndex]);
        } else if (e.key === "Escape") {
            setIsOpen(false);
        }
    }

    function handleReset() {
        setIsVerified(false);
        setQuery("");
        setPredictions([]);
        onChange({ name: value.name, street: "", city: "", state: "", zip: "", verified: false });
        setTimeout(() => inputRef.current?.focus(), 0);
    }

    const displaySummary = isVerified
        ? `${value.street}, ${value.city}, ${value.state} ${value.zip}`.trim()
        : "";

    const hasError = !!error;

    return (
        <div className="space-y-3">
            {/* ── Name field ─────────────────────────────────── */}
            <div>
                <label htmlFor={`${label}-name`} className="text-sm font-medium text-foreground">
                    Name
                </label>
                <input
                    id={`${label}-name`}
                    type="text"
                    value={value.name}
                    onChange={(e) => onChange({ ...value, name: e.target.value })}
                    placeholder="Full Name"
                    className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors placeholder:text-muted-foreground"
                />
            </div>

            {/* ── Address autocomplete ────────────────────────── */}
            <div>
                <label htmlFor={`${label}-address`} className="text-sm font-medium text-foreground">
                    Address
                </label>

                <div ref={containerRef} className="relative mt-1">
                    {/* Map pin icon */}
                    <span className="pointer-events-none absolute left-3 top-[0.6rem] text-base select-none z-10">
                        📍
                    </span>

                    {isVerified ? (
                        /* ── Verified / read-only ─────────────────── */
                        <div className={`
                            flex items-center justify-between rounded-xl border px-3 py-2 pl-9 min-h-[2.5rem]
                            ${hasError ? "border-destructive bg-destructive/5" : "border-border bg-muted/30"}
                        `}>
                            <span className="text-sm text-foreground truncate mr-2">{displaySummary}</span>
                            <div className="flex items-center gap-2 shrink-0">
                                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success whitespace-nowrap">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                                        <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
                                    </svg>
                                    Verified
                                </span>
                                <button type="button" onClick={handleReset}
                                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors">
                                    Change
                                </button>
                            </div>
                        </div>
                    ) : (
                        /* ── Search input ─────────────────────────── */
                        <input
                            id={`${label}-address`}
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={handleQueryChange}
                            onKeyDown={handleKeyDown}
                            onFocus={() => predictions.length > 0 && setIsOpen(true)}
                            placeholder="Start typing your address…"
                            autoComplete="off"
                            className={`
                                w-full rounded-xl border px-3 py-2 pl-9 text-sm
                                outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary
                                transition-colors placeholder:text-muted-foreground
                                ${hasError
                                    ? "border-destructive bg-destructive/5 focus:ring-destructive/40"
                                    : "border-border bg-background"
                                }
                            `}
                        />
                    )}

                    {/* ── Autocomplete dropdown ──────────────────── */}
                    {isOpen && predictions.length > 0 && (
                        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-xl border border-border bg-card shadow-lg overflow-hidden">
                            {predictions.map((p, i) => (
                                <button
                                    key={p.place_id}
                                    type="button"
                                    onMouseDown={(e) => { e.preventDefault(); handleSelect(p); }}
                                    className={`
                                        w-full text-left px-4 py-2.5 transition-colors border-b border-border/50 last:border-0
                                        ${i === activeIndex ? "bg-primary/10" : "hover:bg-muted/60"}
                                    `}
                                >
                                    <p className="text-sm font-medium text-foreground truncate">
                                        {p.main_text || p.description.split(",")[0]}
                                    </p>
                                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                                        {p.secondary_text || p.description.split(",").slice(1).join(",").trim()}
                                    </p>
                                </button>
                            ))}
                            {/* Google attribution (required) */}
                            <div className="px-4 py-1.5 bg-muted/40 flex justify-end">
                                <span className="text-[10px] text-muted-foreground">Powered by Google</span>
                            </div>
                        </div>
                    )}

                    {/* ── Loading dots ──────────────────────────── */}
                    {isLoading && (
                        <div className="absolute right-3 top-1/2 -translate-y-1/2">
                            <svg className="w-4 h-4 animate-spin text-muted-foreground" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                        </div>
                    )}
                </div>

                {/* Error / hint messages */}
                {hasError && <p className="mt-1 text-xs text-destructive">{error}</p>}
                {!isVerified && query.length > 5 && !hasError && !isLoading && predictions.length === 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">No results — try a different address</p>
                )}
                {!isVerified && query.length > 5 && !hasError && predictions.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">Select an address from the dropdown to verify ✓</p>
                )}
            </div>
        </div>
    );
}
