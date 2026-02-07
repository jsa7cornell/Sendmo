// API Route: /api/shipments
// POST - Create a shipment and get rates (proxies to EasyPost, or returns demo rates)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import EasyPostClient from '@easypost/api';

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY;

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

    // Live mode — use EasyPost SDK
    const client = new EasyPostClient(EASYPOST_API_KEY);

    console.log('[Shipment Create] Request:', {
      from: `${data.from_address.city}, ${data.from_address.state} ${data.from_address.zip}`,
      to: `${data.to_address.city}, ${data.to_address.state} ${data.to_address.zip}`,
      parcel: data.parcel
    });

    try {
      const shipment = await client.Shipment.create({
        from_address: data.from_address,
        to_address: data.to_address,
        parcel: data.parcel
      });
      console.log('[Shipment Create] Success:', {
        id: shipment.id,
        ratesCount: shipment.rates?.length || 0
      });
      return NextResponse.json(shipment);
    } catch (easypostError: unknown) {
      const err = easypostError as { message?: string; statusCode?: number; code?: string };
      console.error('[Shipment Create] EasyPost Error:', {
        message: err.message,
        statusCode: err.statusCode,
        code: err.code,
        fullError: JSON.stringify(easypostError)
      });
      return NextResponse.json(
        {
          success: false,
          error: { message: err.message || 'Failed to create shipment' }
        },
        { status: err.statusCode || 500 }
      );
    }

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
