// Backend integration tests for EasyPost API
// These tests verify that our SDK usage is correct for all carriers (USPS, UPS, FedEx)

import { describe, it, expect, beforeAll } from 'vitest';
import EasyPostClient from '@easypost/api';

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY;

// Standard test addresses with all required fields for all carriers
const TEST_FROM_ADDRESS = {
  name: 'Test Sender',
  company: 'SendMo Test Co',
  street1: '417 Montgomery St',
  city: 'San Francisco',
  state: 'CA',
  zip: '94104',
  country: 'US',
  phone: '4155551234',
  email: 'test@sendmo.co'
};

const TEST_TO_ADDRESS = {
  name: 'Test Recipient',
  company: 'Recipient Co',
  street1: '350 Fifth Avenue',
  city: 'New York',
  state: 'NY',
  zip: '10118',
  country: 'US',
  phone: '2125551234'
};

const TEST_PARCEL = {
  length: 10,
  width: 8,
  height: 6,
  weight: 16 // ounces
};

describe('EasyPost SDK Integration', () => {
  let client: InstanceType<typeof EasyPostClient>;
  let endShipperId: string;

  beforeAll(async () => {
    if (!EASYPOST_API_KEY) {
      throw new Error(
        'EASYPOST_API_KEY environment variable is required for backend tests. ' +
        'Make sure it is configured in GitHub Secrets (Settings → Secrets → Actions → EASYPOST_API_KEY)'
      );
    }
    client = new EasyPostClient(EASYPOST_API_KEY);

    // Create an EndShipper - required for platform accounts when purchasing labels
    // EndShipper represents the actual shipper and is required by EasyPost for all carriers
    const endShipper = await client.EndShipper.create({
      name: TEST_FROM_ADDRESS.name,
      company: TEST_FROM_ADDRESS.company,
      street1: TEST_FROM_ADDRESS.street1,
      city: TEST_FROM_ADDRESS.city,
      state: TEST_FROM_ADDRESS.state,
      zip: TEST_FROM_ADDRESS.zip,
      country: TEST_FROM_ADDRESS.country,
      phone: TEST_FROM_ADDRESS.phone,
      email: TEST_FROM_ADDRESS.email
    });
    endShipperId = endShipper.id;
    console.log('EndShipper created:', endShipperId);
  });

  describe('Shipment.create', () => {
    it('creates a shipment and returns rates from multiple carriers', async () => {
      const shipment = await client.Shipment.create({
        from_address: TEST_FROM_ADDRESS,
        to_address: TEST_TO_ADDRESS,
        parcel: TEST_PARCEL
      });

      expect(shipment.id).toMatch(/^shp_/);
      expect(shipment.rates).toBeDefined();
      expect(shipment.rates!.length).toBeGreaterThan(0);

      // Verify rate structure
      const rate = shipment.rates![0];
      expect(rate.id).toMatch(/^rate_/);
      expect(rate.carrier).toBeDefined();
      expect(rate.service).toBeDefined();
      expect(rate.rate).toBeDefined();

      // Log available carriers for debugging
      const carriers = [...new Set(shipment.rates!.map(r => r.carrier))];
      console.log('Available carriers:', carriers);
    });
  });

  describe('Shipment.buy', () => {
    // Helper to buy a shipment with a specific carrier
    async function buyWithCarrier(carrierName: string) {
      const shipment = await client.Shipment.create({
        from_address: TEST_FROM_ADDRESS,
        to_address: TEST_TO_ADDRESS,
        parcel: TEST_PARCEL
      });

      expect(shipment.rates!.length).toBeGreaterThan(0);

      // Find a rate from the specified carrier
      const carrierRate = shipment.rates!.find(r => r.carrier === carrierName);
      if (!carrierRate) {
        console.log(`No ${carrierName} rates available, skipping`);
        return null;
      }

      // Always pass EndShipper ID - required for platform accounts
      // Signature: buy(shipmentId, rate, insuranceAmount, endShipperId)
      const purchased = await client.Shipment.buy(shipment.id, carrierRate, null, endShipperId);
      return purchased;
    }

    it('purchases a shipment with USPS', async () => {
      const purchased = await buyWithCarrier('USPS');

      if (purchased) {
        expect(purchased.tracking_code).toBeDefined();
        expect(purchased.postage_label).toBeDefined();
        expect(purchased.selected_rate).toBeDefined();
        expect(purchased.selected_rate?.carrier).toBe('USPS');
        console.log('USPS purchase successful:', purchased.tracking_code);
      } else {
        console.log('USPS rates not available');
      }
    });

    it('purchases a shipment with UPS', async () => {
      const purchased = await buyWithCarrier('UPS');

      if (purchased) {
        expect(purchased.tracking_code).toBeDefined();
        expect(purchased.postage_label).toBeDefined();
        expect(purchased.selected_rate).toBeDefined();
        expect(purchased.selected_rate?.carrier).toBe('UPS');
        console.log('UPS purchase successful:', purchased.tracking_code);
      } else {
        console.log('UPS rates not available');
      }
    });

    it('purchases a shipment with FedEx', async () => {
      const purchased = await buyWithCarrier('FedEx');

      if (purchased) {
        expect(purchased.tracking_code).toBeDefined();
        expect(purchased.postage_label).toBeDefined();
        expect(purchased.selected_rate).toBeDefined();
        expect(['FedEx', 'FEDEX']).toContain(purchased.selected_rate?.carrier);
        console.log('FedEx purchase successful:', purchased.tracking_code);
      } else {
        console.log('FedEx rates not available');
      }
    });

    it('can retrieve shipment and buy with rate', async () => {
      // Create shipment
      const shipment = await client.Shipment.create({
        from_address: TEST_FROM_ADDRESS,
        to_address: TEST_TO_ADDRESS,
        parcel: TEST_PARCEL
      });

      // Get a USPS rate (most reliable for testing)
      const uspsRate = shipment.rates!.find(r => r.carrier === 'USPS');
      const rate = uspsRate || shipment.rates![0];

      // Retrieve shipment (simulates what our API does)
      const retrieved = await client.Shipment.retrieve(shipment.id);
      expect(retrieved.id).toBe(shipment.id);

      // Buy with EndShipper ID - required for platform accounts
      // Signature: buy(shipmentId, rate, insuranceAmount, endShipperId)
      const purchased = await client.Shipment.buy(shipment.id, rate, null, endShipperId);
      expect(purchased.tracking_code).toBeDefined();
    });
  });

  describe('Address verification', () => {
    it('verifies a valid address', async () => {
      const address = await client.Address.create({
        street1: '417 Montgomery St',
        city: 'San Francisco',
        state: 'CA',
        zip: '94104',
        country: 'US',
        verify: ['delivery']
      });

      expect(address.id).toMatch(/^adr_/);
      expect(address.verifications).toBeDefined();
    });
  });
});
