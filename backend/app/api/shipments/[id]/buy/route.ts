// API Route: /api/shipments/[id]/buy
// POST - Purchase a shipping label for an existing shipment

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY;
const EASYPOST_API_URL = 'https://api.easypost.com/v2';

const BuyShipmentSchema = z.object({
  rate_id: z.string().min(1)
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!EASYPOST_API_KEY) {
      return NextResponse.json(
        { success: false, error: { message: 'Shipping service is not configured' } },
        { status: 503 }
      );
    }

    const shipmentId = params.id;
    if (!shipmentId) {
      return NextResponse.json(
        { success: false, error: { message: 'Shipment ID is required' } },
        { status: 400 }
      );
    }

    const body = await req.json();
    const { rate_id } = BuyShipmentSchema.parse(body);

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
