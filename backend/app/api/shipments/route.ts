// API Route: /api/shipments
// POST - Create a shipment and get rates (proxies to EasyPost, or returns demo rates)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY;
const EASYPOST_API_URL = 'https://api.easypost.com/v2';

const AddressSchema = z.object({
  street1: z.string().min(1),
  street2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  zip: z.string().min(1),
  country: z.string().default('US')
});

const ParcelSchema = z.object({
  length: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  weight: z.number().positive()
});

const CreateShipmentSchema = z.object({
  from_address: AddressSchema,
  to_address: AddressSchema,
  parcel: ParcelSchema
});

function generateMockRates(weight: number) {
  const basePrice = Math.max(3.5, weight * 0.35);
  const id = crypto.randomUUID();

  return {
    id: `shp_demo_${id}`,
    mode: 'demo',
    rates: [
      {
        id: `rate_usps_priority_${id}`,
        carrier: 'USPS',
        service: 'Priority Mail',
        rate: (basePrice * 1.2).toFixed(2),
        delivery_days: 3,
        est_delivery_days: 3,
      },
      {
        id: `rate_usps_ground_${id}`,
        carrier: 'USPS',
        service: 'Ground Advantage',
        rate: basePrice.toFixed(2),
        delivery_days: 5,
        est_delivery_days: 5,
      },
      {
        id: `rate_ups_ground_${id}`,
        carrier: 'UPS',
        service: 'Ground',
        rate: (basePrice * 1.4).toFixed(2),
        delivery_days: 5,
        est_delivery_days: 5,
      },
      {
        id: `rate_usps_express_${id}`,
        carrier: 'USPS',
        service: 'Express Mail',
        rate: (basePrice * 2.5).toFixed(2),
        delivery_days: 1,
        est_delivery_days: 1,
      },
      {
        id: `rate_fedex_ground_${id}`,
        carrier: 'FedEx',
        service: 'Ground',
        rate: (basePrice * 1.5).toFixed(2),
        delivery_days: 5,
        est_delivery_days: 5,
      },
    ],
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const data = CreateShipmentSchema.parse(body);

    // Demo mode — return mock rates when no EasyPost key is configured
    if (!EASYPOST_API_KEY) {
      const mockShipment = generateMockRates(data.parcel.weight);
      return NextResponse.json(mockShipment);
    }

    // Live mode — proxy to EasyPost
    const response = await fetch(`${EASYPOST_API_URL}/shipments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(EASYPOST_API_KEY + ':').toString('base64')}`
      },
      body: JSON.stringify({
        shipment: {
          from_address: data.from_address,
          to_address: data.to_address,
          parcel: data.parcel
        }
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return NextResponse.json(
        { success: false, error: { message: error.error?.message || 'Failed to create shipment' } },
        { status: response.status }
      );
    }

    const shipment = await response.json();
    return NextResponse.json(shipment);

  } catch (error) {
    console.error('Create shipment error:', error);

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
