import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";

const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You are a shipping package estimator for SendMo, a US prepaid-shipping service.

Given a short user description of an item being shipped, return your best estimate of its packaged dimensions, weight, packaging type, and the user's apparent speed preference.

Guidelines:
- Dimensions are the OUTSIDE of the shipping container (box/envelope/tube), in inches. Add ~1-2 inches per side beyond the bare item for padding.
- Weight is the TOTAL packaged weight in pounds (item + packaging materials). Round to one decimal.
- packaging: "envelope" only for thin/flat items under ~1 inch thick (documents, soft clothing, books under ~1lb). "tube" for long cylindrical items (posters, skis, fishing rods). "box" for everything else.
- speedHint: detect phrases like "cheap"/"no rush"/"affordable" → economy; "asap"/"rush"/"overnight"/"urgent" → express; "next week"/"normal"/"standard" → standard. If no signal, return null.
- When uncertain between two reasonable values, pick the LARGER size and HEAVIER weight. Under-declaring triggers carrier adjustment fees. Better to slightly overestimate.
- confidence: "high" when the item is unambiguous and common (laptop, book, shoes). "medium" when reasonable ranges exist (vase, painting, electronics). "low" when the description is vague ("a gift", "stuff", "thing").
- itemName: a clean 1-3 word noun phrase suitable for a shipping label description (e.g. "Hardcover book", "Ceramic vase", "Pair of running shoes").
- notes: empty string when confidence is high. When medium/low, one short sentence explaining the assumption (e.g. "Assumed standard 9x12 framed print"). Shown to the user.

Always call the return_estimate tool. Never respond with plain text.`;

const TOOL_SCHEMA = {
    name: "return_estimate",
    description: "Return the structured shipping estimate for the described item.",
    input_schema: {
        type: "object",
        properties: {
            itemName: { type: "string", description: "Clean 1-3 word noun phrase for the item" },
            packaging: { type: "string", enum: ["box", "envelope", "tube"] },
            length_in: { type: "number", description: "Outside length in inches" },
            width_in: { type: "number", description: "Outside width in inches" },
            height_in: { type: "number", description: "Outside height in inches (use 1 for envelope)" },
            weight_lbs: { type: "number", description: "Total packaged weight in pounds" },
            speedHint: { type: ["string", "null"], enum: ["economy", "standard", "express", null] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            notes: { type: "string", description: "Short assumption note when confidence < high; empty string otherwise" },
        },
        required: ["itemName", "packaging", "length_in", "width_in", "height_in", "weight_lbs", "speedHint", "confidence", "notes"],
    },
};

serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const sessionId = req.headers.get("x-session-id") || "unknown";
    const start = Date.now();

    try {
        const { description } = await req.json();

        if (!description || typeof description !== "string" || !description.trim()) {
            return new Response(
                JSON.stringify({ error: "Missing required field: description" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
        if (!apiKey) {
            return new Response(
                JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const trimmed = description.trim().slice(0, 500);

        const response = await fetch(ANTHROPIC_URL, {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 400,
                system: [
                    {
                        type: "text",
                        text: SYSTEM_PROMPT,
                        cache_control: { type: "ephemeral" },
                    },
                ],
                tools: [TOOL_SCHEMA],
                tool_choice: { type: "tool", name: "return_estimate" },
                messages: [{ role: "user", content: trimmed }],
            }),
        });

        const data = await response.json();
        const elapsed = Date.now() - start;

        if (!response.ok) {
            const errorMsg = data?.error?.message || `Anthropic API error ${response.status}`;
            console.error(`[Session ${sessionId}] [guestimate] Anthropic error:`, JSON.stringify(data));
            log({
                event_type: "guestimate.error",
                session_id: sessionId,
                severity: "error",
                entity_type: "guestimate",
                duration_ms: elapsed,
                properties: { error_message: errorMsg, status: response.status },
            });
            return new Response(
                JSON.stringify({ error: errorMsg }),
                { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const toolUse = (data.content || []).find((b: { type: string }) => b.type === "tool_use");
        if (!toolUse?.input) {
            console.error(`[Session ${sessionId}] [guestimate] No tool_use in response:`, JSON.stringify(data));
            return new Response(
                JSON.stringify({ error: "Model did not return a structured estimate" }),
                { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const est = toolUse.input as {
            itemName: string;
            packaging: "box" | "envelope" | "tube";
            length_in: number;
            width_in: number;
            height_in: number;
            weight_lbs: number;
            speedHint: "economy" | "standard" | "express" | null;
            confidence: "high" | "medium" | "low";
            notes: string;
        };

        log({
            event_type: "guestimate.success",
            session_id: sessionId,
            severity: "info",
            entity_type: "guestimate",
            duration_ms: elapsed,
            properties: {
                description_length: trimmed.length,
                item_name: est.itemName,
                packaging: est.packaging,
                weight_lbs: est.weight_lbs,
                confidence: est.confidence,
                speed_hint: est.speedHint,
                input_tokens: data.usage?.input_tokens,
                cache_read_tokens: data.usage?.cache_read_input_tokens,
                output_tokens: data.usage?.output_tokens,
            },
        });

        return new Response(
            JSON.stringify(est),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err) {
        console.error(`[Session ${sessionId}] Guestimate error:`, err);
        return new Response(
            JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
