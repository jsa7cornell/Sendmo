// API Route: /api/shipments/[id]/buy
// POST - Purchase a shipping label for an existing shipment (or mock in demo mode)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import EasyPostClient from '@easypost/api';

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY;

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

    // Live mode — use EasyPost SDK
    const client = new EasyPostClient(EASYPOST_API_KEY);

    console.log('[Shipment Buy] Request:', {
      shipmentId,
      rateId: rate_id
    });

    try {
      const purchasedShipment = await client.Shipment.buy(shipmentId, { id: rate_id });
      console.log('[Shipment Buy] Success:', {
        id: purchasedShipment.id,
        trackingCode: purchasedShipment.tracking_code,
        hasLabel: !!purchasedShipment.postage_label
      });
      return NextResponse.json(purchasedShipment);
    } catch (easypostError: unknown) {
      const err = easypostError as { message?: string; statusCode?: number; code?: string };
      console.error('[Shipment Buy] EasyPost Error:', {
        shipmentId,
        rateId: rate_id,
        message: err.message,
        statusCode: err.statusCode,
        code: err.code,
        fullError: JSON.stringify(easypostError)
      });
      return NextResponse.json(
        {
          success: false,
          error: {
            message: err.message || 'Failed to purchase shipment'
          }
        },
        { status: err.statusCode || 500 }
      );
    }

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
