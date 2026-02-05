// API Route: /api/shipments
// POST - Create a shipment and get rates (proxies to EasyPost)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

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

export async function POST(req: NextRequest) {
  try {
    if (!EASYPOST_API_KEY) {
      return NextResponse.json(
        { success: false, error: { message: 'Shipping service is not configured' } },
        { status: 503 }
      );
    }

    const body = await req.json();
    const data = CreateShipmentSchema.parse(body);

    const response = await fetch(`${EASYPOST_API_URL}/shipments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${EASYPOST_API_KEY}`
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
