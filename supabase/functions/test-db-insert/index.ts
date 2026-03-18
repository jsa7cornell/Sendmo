import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

serve(async (req: Request) => {
    // Handle CORS preflight
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    try {
        const { mockData, rate } = await req.json();

        const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
        const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");

        if (!sbUrl || !sbKey) {
            return new Response(JSON.stringify({ error: "Server DB config missing" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const supabase = createClient(sbUrl, sbKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });
        const testUserId = "b0000000-0000-0000-0000-000000000000"; // unique, valid uuid

        // Create mock user in auth.users first to satisfy foreign keys
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
            id: testUserId,
            email: "test_label_generator@example.com",
            password: "TestPassword123!@",
            email_confirm: true,
            user_metadata: { full_name: "Test User" }
        });

        // 422 usually means user already exists in Supabase GoTrue
        if (authError && authError.status !== 422 && authError.message !== "User already registered") {
            throw new Error("Failed to create auth user: " + authError.message);
        }

        // Create mock profile
        const { error: profileError } = await supabase.from("profiles").upsert({
            id: testUserId,
            email: mockData.email || "test_label_generator@example.com",
            full_name: mockData.from_name || "Test User",
        });
        if (profileError) throw new Error("Profile error: " + profileError.message);


        // Create mock address
        const { data: addressData, error: addressError } = await supabase.from("addresses").insert({
            user_id: testUserId,
            name: mockData.to_name || "Test Recipient",
            street1: "123 Test St",
            city: "Test City",
            state: "CA",
            zip: "12345",
            country: "US",
            is_verified: true,
        }).select().single();

        if (addressError) throw addressError;

        if (addressData) {
            // Create mock link
            const shortCode = "test_" + Math.random().toString(36).substring(2, 8);
            const { data: linkData, error: linkError } = await supabase.from("sendmo_links").insert({
                user_id: testUserId,
                short_code: shortCode,
                link_type: "full_label",
                status: "used",
                recipient_address_id: addressData.id,
                sender_name: mockData.from_name || "SendMo Test",
                max_price_cents: 10000,
            }).select().single();

            if (linkError) throw linkError;

            if (linkData) {
                // Create mock shipment
                // is_test is set server-side here — never derived from client params.
                // This shipment was created with the test carrier API key, so it is
                // definitionally a test record. Test labels cannot be voided via the
                // carrier API (they are synthetic with fake tracking numbers).
                const { error: shipmentError } = await supabase.from("shipments").insert({
                    link_id: linkData.id,
                    recipient_address_id: addressData.id,
                    easypost_shipment_id: rate.easypost_shipment_id,
                    carrier: rate.carrier || "",
                    service: rate.service || "",
                    tracking_number: rate.tracking_number,
                    label_url: rate.label_url,
                    rate_cents: mockData.rate_cents,
                    display_price_cents: mockData.rate_cents,
                    status: "label_created",
                    is_test: true,   // always true for test-db-insert records
                    weight_oz: mockData.weight_oz || 16,
                    length_in: mockData.length_in || 10,
                    width_in: mockData.width_in || 10,
                    height_in: mockData.height_in || 10,
                });

                if (shipmentError) throw shipmentError;
            }
        }

        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (err: any) {
        console.error("Test DB insert error:", err);
        return new Response(JSON.stringify({ error: err.message || "Failed to insert test records" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
});
