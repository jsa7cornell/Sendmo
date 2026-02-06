// API Route: /api/address/verify
// POST - Verify and correct an address using EasyPost

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY;
const EASYPOST_API_URL = 'https://api.easypost.com/v2';

const AddressSchema = z.object({
  street1: z.string().optional(),
  street2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  country: z.string().default('US')
});

// ZIP code to city/state lookup (common ones for demo mode)
const ZIP_LOOKUP: Record<string, { city: string; state: string }> = {
  '10001': { city: 'New York', state: 'NY' },
  '90210': { city: 'Beverly Hills', state: 'CA' },
  '60601': { city: 'Chicago', state: 'IL' },
  '77001': { city: 'Houston', state: 'TX' },
  '85001': { city: 'Phoenix', state: 'AZ' },
  '19101': { city: 'Philadelphia', state: 'PA' },
  '78201': { city: 'San Antonio', state: 'TX' },
  '92101': { city: 'San Diego', state: 'CA' },
  '75201': { city: 'Dallas', state: 'TX' },
  '95101': { city: 'San Jose', state: 'CA' },
  '78701': { city: 'Austin', state: 'TX' },
  '94102': { city: 'San Francisco', state: 'CA' },
  '98101': { city: 'Seattle', state: 'WA' },
  '80201': { city: 'Denver', state: 'CO' },
  '20001': { city: 'Washington', state: 'DC' },
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const address = AddressSchema.parse(body);

    // Demo mode - do basic validation and ZIP lookup
    if (!EASYPOST_API_KEY) {
      const result: {
        valid: boolean;
        corrected: typeof address;
        suggestions: string[];
        errors: string[];
      } = {
        valid: false,
        corrected: { ...address },
        suggestions: [],
        errors: []
      };

      // If we have ZIP, try to fill in city/state
      if (address.zip) {
        const zipPrefix = address.zip.substring(0, 5);
        const lookup = ZIP_LOOKUP[zipPrefix];
        if (lookup) {
          if (!address.city) {
            result.corrected.city = lookup.city;
            result.suggestions.push(`City set to ${lookup.city} based on ZIP code`);
          }
          if (!address.state) {
            result.corrected.state = lookup.state;
            result.suggestions.push(`State set to ${lookup.state} based on ZIP code`);
          }
        }
      }

      // Validate required fields
      if (!result.corrected.street1) {
        result.errors.push('Street address is required');
      }
      if (!result.corrected.zip && !result.corrected.city) {
        result.errors.push('Either ZIP code or city is required');
      }

      result.valid = result.errors.length === 0 && !!result.corrected.street1;

      return NextResponse.json(result);
    }

    // Live mode - use EasyPost verification
    const response = await fetch(`${EASYPOST_API_URL}/addresses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${EASYPOST_API_KEY}`
      },
      body: JSON.stringify({
        address: {
          street1: address.street1,
          street2: address.street2,
          city: address.city,
          state: address.state,
          zip: address.zip,
          country: address.country
        },
        verify: ['delivery']
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return NextResponse.json({
        valid: false,
        corrected: address,
        suggestions: [],
        errors: [error.error?.message || 'Could not verify address']
      });
    }

    const data = await response.json();
    const verifications = data.verifications?.delivery;

    const result = {
      valid: verifications?.success === true,
      corrected: {
        street1: data.street1 || address.street1,
        street2: data.street2 || address.street2,
        city: data.city || address.city,
        state: data.state || address.state,
        zip: data.zip || address.zip,
        country: data.country || 'US'
      },
      suggestions: [] as string[],
      errors: [] as string[]
    };

    // Check for corrections
    if (data.street1 && data.street1 !== address.street1) {
      result.suggestions.push(`Street corrected to: ${data.street1}`);
    }
    if (data.city && data.city !== address.city) {
      result.suggestions.push(`City corrected to: ${data.city}`);
    }
    if (data.state && data.state !== address.state) {
      result.suggestions.push(`State corrected to: ${data.state}`);
    }
    if (data.zip && data.zip !== address.zip) {
      result.suggestions.push(`ZIP corrected to: ${data.zip}`);
    }

    // Check for errors
    if (verifications?.errors) {
      for (const err of verifications.errors) {
        result.errors.push(err.message);
      }
    }

    return NextResponse.json(result);

  } catch (error) {
    console.error('Address verification error:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { valid: false, corrected: null, suggestions: [], errors: ['Invalid address format'] },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { valid: false, corrected: null, suggestions: [], errors: ['Verification service unavailable'] },
      { status: 500 }
    );
  }
}
