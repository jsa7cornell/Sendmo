// API Route: /api/shipments/[id]/buy
// POST - Purchase a shipping label for an existing shipment (or mock in demo mode)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY;
const EASYPOST_API_URL = 'https://api.easypost.com/v2';

const BuyShipmentSchema = z.object({
  rate_id: z.string().min(1)
});

function generateMockPurchase(shipmentId: string, rateId: string) {
  const trackingNum = `DEMO${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

  // Parse carrier from the rate_id (e.g. rate_usps_priority_xxx -> USPS Priority Mail)
  let carrier = 'USPS';
  let service = 'Priority Mail';
  if (rateId.includes('ups')) { carrier = 'UPS'; service = 'Ground'; }
  if (rateId.includes('fedex')) { carrier = 'FedEx'; service = 'Ground'; }
  if (rateId.includes('express')) { service = 'Express Mail'; }
  if (rateId.includes('ground_adv') || rateId.includes('usps_ground')) { service = 'Ground Advantage'; }

  return {
    id: shipmentId,
    mode: 'demo',
    tracking_code: trackingNum,
    selected_rate: {
      id: rateId,
      carrier,
      service,
      rate: '8.50',
    },
    postage_label: {
      id: `pl_demo_${crypto.randomUUID()}`,
      label_url: null, // No real label in demo mode
    },
    tracker: {
      id: `trk_demo_${crypto.randomUUID()}`,
      tracking_code: trackingNum,
      status: 'pre_transit',
    },
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: shipmentId } = await params;
    if (!shipmentId) {
      return NextResponse.json(
        { success: false, error: { message: 'Shipment ID is required' } },
        { status: 400 }
      );
    }

    const body = await req.json();
    const { rate_id } = BuyShipmentSchema.parse(body);

    // Demo mode — return mock purchase when no EasyPost key is configured
    if (!EASYPOST_API_KEY) {
      const mockPurchase = generateMockPurchase(shipmentId, rate_id);
      return NextResponse.json(mockPurchase);
    }

    // Live mode — proxy to EasyPost
    const response = await fetch(`${EASYPOST_API_URL}/shipments/${shipmentId}/buy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${EASYPOST_API_KEY}`
      },
      body: JSON.stringify({
        rate: { id: rate_id }
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return NextResponse.json(
        { success: false, error: { message: error.error?.message || 'Failed to purchase shipment' } },
        { status: response.status }
      );
    }

    const purchasedShipment = await response.json();
    return NextResponse.json(purchasedShipment);

  } catch (error) {
    console.error('Buy shipment error:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: { message: 'Invalid request data', details: error.errors } },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { success: false, error: { message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
