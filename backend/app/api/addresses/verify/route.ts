// API Route: /api/addresses/verify
// POST - Verify an address and cache it

import { NextRequest, NextResponse } from 'next/server';
import { verifyAddress, parseAddressString } from '@/lib/address-verification';
import { getServerSession } from 'next-auth';
import { z } from 'zod';

const VerifyAddressSchema = z.object({
  address: z.union([
    z.string(), // Raw address string to parse
    z.object({
      street1: z.string().min(1),
      street2: z.string().optional(),
      city: z.string().min(1),
      state: z.string().length(2),
      zip: z.string().regex(/^\d{5}(-\d{4})?$/),
      country: z.string().default('US')
    })
  ])
});

export async function POST(req: NextRequest) {
  try {
    // Parse request body
    const body = await req.json();
    const { address } = VerifyAddressSchema.parse(body);
    
    // Get user session (optional - works without login too)
    const session = await getServerSession();
    const userId = session?.user?.id;
    
    // Parse address if it's a string
    let addressObj;
    if (typeof address === 'string') {
      addressObj = parseAddressString(address);
      if (!addressObj) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'INVALID_FORMAT',
              message: 'Could not parse address. Please check format.'
            }
          },
          { status: 400 }
        );
      }
    } else {
      addressObj = address;
    }
    
    // Verify address
        const result = await verifyAddress(addressObj, userId);
    
    // Accept address if we got data back from EasyPost (even without verification)
    if (result.corrected && result.cachedAddressId) {
      return NextResponse.json({
        success: true,
        data: {
          verified: result.verified,
          corrected: result.corrected,
          addressId: result.cachedAddressId,
          easypostId: result.easypostId,
          suggestions: result.suggestions
        }
      });
    } else {
      return NextResponse.json({
        success: false,
        error: {
          code: 'VERIFICATION_FAILED',
          message: result.errors?.[0] || 'Address could not be verified',
          details: {
            errors: result.errors,
            suggestions: result.suggestions
          }
        }
      }, { status: 400 });
    }
    
  } catch (error) {
    console.error('Address verification API error:', error);
    
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: error.errors
          }
        },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An error occurred while verifying the address'
        }
      },
      { status: 500 }
    );
  }
}
