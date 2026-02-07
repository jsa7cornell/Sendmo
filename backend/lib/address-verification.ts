// Address Verification Service
import { PrismaClient } from '@prisma/client';

// Singleton pattern to prevent connection pool exhaustion in serverless
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY;
const EASYPOST_API_URL = 'https://api.easypost.com/v2';

export interface AddressInput {
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

export interface VerificationResult {
  valid: boolean;
  verified: boolean;
  corrected?: AddressInput;
  easypostId?: string;
  verificationData?: any;
  errors?: string[];
  suggestions?: string[];
  cachedAddressId?: string;
}

export async function verifyAddress(
  address: AddressInput,
  userId?: string
): Promise<VerificationResult> {
  if (!EASYPOST_API_KEY) {
    return {
      valid: false,
      verified: false,
      errors: ['EASYPOST_API_KEY is not configured']
    };
  }

  try {
    const cached = await findCachedAddress(address);
    if (cached) {
      console.log('Address found in cache:', cached.id);
      await prisma.address.update({
        where: { id: cached.id },
        data: {
          lastUsedAt: new Date(),
          usedAsDestinationCount: { increment: 1 }
        }
      });
      return {
        valid: cached.verified,
        verified: cached.verified,
        corrected: {
          street1: cached.street1,
          street2: cached.street2 || undefined,
          city: cached.city,
          state: cached.state,
          zip: cached.zip,
          country: cached.country
        },
        easypostId: cached.easypostId || undefined,
        verificationData: cached.verificationData as any,
        cachedAddressId: cached.id
      };
    }
    
    console.log('Verifying address with EasyPost...');
    const response = await fetch(`${EASYPOST_API_URL}/addresses`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(EASYPOST_API_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        address: {
          street1: address.street1,
          street2: address.street2,
          city: address.city,
          state: address.state,
          zip: address.zip,
          country: address.country || 'US'
        }
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Address verification failed');
    }
    
    const data = await response.json();
    const verifications = data.verifications?.delivery;
    const hasErrors = verifications?.errors && verifications.errors.length > 0;
    const isValid = verifications?.success === true;
    const errors = verifications?.errors?.map((e: any) => e.message) || [];
    const suggestions = verifications?.details ? [
      `Latitude: ${verifications.details.latitude}`,
      `Longitude: ${verifications.details.longitude}`,
      `Time Zone: ${verifications.details.time_zone}`
    ] : [];
    
    const savedAddress = await prisma.address.create({
      data: {
        userId: userId,
        street1: data.street1,
        street2: data.street2,
        city: data.city,
        state: data.state,
        zip: data.zip,
        country: data.country || 'US',
        verified: isValid,
        verifiedAt: isValid ? new Date() : null,
        easypostId: data.id,
        verificationData: data,
        usedAsDestinationCount: 1,
        lastUsedAt: new Date()
      }
    });
    
    console.log('Address saved to database:', savedAddress.id);
    
    if (userId && isValid) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { defaultShippingAddressId: true }
      });
      if (!user?.defaultShippingAddressId) {
        await prisma.user.update({
          where: { id: userId },
          data: { defaultShippingAddressId: savedAddress.id }
        });
      }
    }
    
    return {
      valid: isValid,
      verified: isValid,
      corrected: {
        street1: data.street1,
        street2: data.street2,
        city: data.city,
        state: data.state,
        zip: data.zip,
        country: data.country
      },
      easypostId: data.id,
      verificationData: data,
      errors: hasErrors ? errors : undefined,
      suggestions: suggestions,
      cachedAddressId: savedAddress.id
    };
  } catch (error) {
    console.error('Address verification error:', error);
    return {
      valid: false,
      verified: false,
      errors: [error instanceof Error ? error.message : 'Verification failed']
    };
  }
}

async function findCachedAddress(address: AddressInput) {
  return await prisma.address.findFirst({
    where: {
      street1: { equals: address.street1, mode: 'insensitive' },
      city: { equals: address.city, mode: 'insensitive' },
      state: { equals: address.state, mode: 'insensitive' },
      zip: address.zip,
      verified: true
    },
    orderBy: { lastUsedAt: 'desc' }
  });
}

export function parseAddressString(addressString: string): AddressInput | null {
  const lines = addressString.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;
  const street1 = lines[0].trim();
  const lastLine = lines[lines.length - 1].trim();
  let city = '', state = '', zip = '';
  const commaParts = lastLine.split(',').map(s => s.trim());
  if (commaParts.length >= 2) {
    city = commaParts[0];
    const stateZipParts = commaParts[1].split(/\s+/).filter(s => s);
    if (stateZipParts.length >= 2) {
      state = stateZipParts[0];
      zip = stateZipParts[1];
    } else if (stateZipParts.length === 1) {
      // Single token — determine if it's a state or zip
      const token = stateZipParts[0];
      if (/^\d{5}(-\d{4})?$/.test(token)) {
        zip = token;
      } else {
        state = token;
      }
    }
  } else {
    const parts = lastLine.split(/\s+/).filter(s => s);
    if (parts.length >= 3) {
      zip = parts[parts.length - 1];
      state = parts[parts.length - 2];
      city = parts.slice(0, parts.length - 2).join(' ');
    } else if (parts.length === 2) {
      state = parts[0];
      zip = parts[1];
    }
  }
  if (!street1 || !zip) return null;
  return { street1, city: city || 'Unknown', state: state || '', zip, country: 'US' };
}
