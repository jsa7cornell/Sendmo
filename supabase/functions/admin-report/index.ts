import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");

    if (!sbUrl || !sbKey) {
      return new Response(JSON.stringify({ error: "Server DB config missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(sbUrl, sbKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await supabase
      .from("sendmo_links")
      .select(`
                id,
                short_code,
                link_type,
                status,
                created_at,
                profiles ( email ),
                shipments (
                    id,
                    easypost_shipment_id,
                    carrier,
                    service,
                    tracking_number,
                    label_url,
                    rate_cents,
                    status,
                    is_test,
                    is_live,
                    refund_status,
                    refund_submitted_at,
                    cancelled_at,
                    created_at,
                    payments ( amount_cents, stripe_payment_intent_id ),
                    sender_address:sender_address_id ( name, street1, city, state, zip ),
                    recipient_address:recipient_address_id ( name, street1, city, state, zip )
                )
            `)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Admin report query error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("Admin report error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
