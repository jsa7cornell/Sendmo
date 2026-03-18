import { test, expect } from '@playwright/test';

test('Edge Functions accept CORS preflight requests for X-Session-ID', async ({ request }) => {
    const endpoints = ['addresses', 'rates', 'labels'];

    for (const endpoint of endpoints) {
        // We send an OPTIONS request mimicking the browser's preflight check
        const response = await request.fetch(`https://fkxykvzsqdjzhurntgah.supabase.co/functions/v1/${endpoint}`, {
            method: 'OPTIONS',
            headers: {
                'Origin': 'http://localhost:5173',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization,content-type,x-session-id',
            }
        });

        expect(response.status(), `Endpoint ${endpoint} failed CORS preflight`).toBe(200);

        // Verify that the function allows our required headers
        const allowHeaders = response.headers()['access-control-allow-headers'];
        expect(allowHeaders.toLowerCase(), `Endpoint ${endpoint} missing x-session-id`).toContain('x-session-id');
        expect(allowHeaders.toLowerCase(), `Endpoint ${endpoint} missing authorization`).toContain('authorization');
        expect(allowHeaders.toLowerCase(), `Endpoint ${endpoint} missing content-type`).toContain('content-type');
    }
});
