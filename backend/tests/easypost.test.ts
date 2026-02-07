// Backend integration tests for EasyPost API
// These tests verify that our SDK usage is correct

import { describe, it, expect, beforeAll } from 'vitest';
import EasyPostClient from '@easypost/api';

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY;

// Skip tests if no API key (CI without secrets)
const describeWithKey = EASYPOST_API_KEY ? describe : describe.skip;

describeWithKey('EasyPost SDK Integration', () => {
  let client: InstanceType<typeof EasyPostClient>;

  beforeAll(() => {
    client = new EasyPostClient(EASYPOST_API_KEY!);
  });

  describe('Shipment.create', () => {
    it('creates a shipment and returns rates', async () => {
      const shipment = await client.Shipment.create({
        from_address: {
          street1: '123 Main St',
          city: 'San Francisco',
          state: 'CA',
          zip: '94102',
          country: 'US'
        },
        to_address: {
          street1: '456 Oak Ave',
          city: 'New York',
          state: 'NY',
          zip: '10001',
          country: 'US'
        },
        parcel: {
          length: 10,
          width: 8,
          height: 6,
          weight: 16
        }
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
    });
  });

  describe('Shipment.buy', () => {
    it('purchases a shipment with full rate object', async () => {
      // First create a shipment
      const shipment = await client.Shipment.create({
        from_address: {
          street1: '123 Main St',
          city: 'San Francisco',
          state: 'CA',
          zip: '94102',
          country: 'US'
        },
        to_address: {
          street1: '456 Oak Ave',
          city: 'New York',
          state: 'NY',
          zip: '10001',
          country: 'US'
        },
        parcel: {
          length: 10,
          width: 8,
          height: 6,
          weight: 16
        }
      });

      expect(shipment.rates!.length).toBeGreaterThan(0);
      const rate = shipment.rates![0]; // Full rate object, not just ID

      // Buy with the full rate object
      const purchased = await client.Shipment.buy(shipment.id, rate);

      expect(purchased.id).toBe(shipment.id);
      expect(purchased.tracking_code).toBeDefined();
      expect(purchased.postage_label).toBeDefined();
      expect(purchased.selected_rate).toBeDefined();
    });

    it('can retrieve shipment and buy with rate from it', async () => {
      // Create shipment
      const shipment = await client.Shipment.create({
        from_address: {
          street1: '123 Main St',
          city: 'San Francisco',
          state: 'CA',
          zip: '94102',
          country: 'US'
        },
        to_address: {
          street1: '456 Oak Ave',
          city: 'New York',
          state: 'NY',
          zip: '10001',
          country: 'US'
        },
        parcel: {
          length: 10,
          width: 8,
          height: 6,
          weight: 16
        }
      });

      const rateId = shipment.rates![0].id;

      // Retrieve shipment (simulates what our API does)
      const retrieved = await client.Shipment.retrieve(shipment.id);
      const rate = retrieved.rates?.find((r: { id: string }) => r.id === rateId);

      expect(rate).toBeDefined();

      // Buy with retrieved rate
      const purchased = await client.Shipment.buy(shipment.id, rate);
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
