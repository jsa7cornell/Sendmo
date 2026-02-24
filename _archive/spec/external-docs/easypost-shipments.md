# EasyPost Shipments & Labels API Reference

> **Source**: EasyPost API Documentation
> **Relevant for**: Rate shopping, label generation, tracking
> **API Version**: v2

---

## Overview

The Shipments API is the core of EasyPost. A Shipment represents a package being sent from one address to another, and includes rates from multiple carriers and the ability to purchase labels.

---

## Shipment Lifecycle

```
Create Shipment → Get Rates → Buy Label → Track Package
      │               │            │            │
      ▼               ▼            ▼            ▼
  addresses      rate objects   label URL    tracking events
  + parcel       from carriers  + tracking#
```

---

## Shipment Object

```json
{
  "id": "shp_xxx",
  "object": "Shipment",
  "mode": "test",
  "to_address": { /* Address object */ },
  "from_address": { /* Address object */ },
  "parcel": {
    "id": "prcl_xxx",
    "length": 10.0,
    "width": 8.0,
    "height": 4.0,
    "weight": 16.0
  },
  "rates": [
    {
      "id": "rate_xxx",
      "carrier": "USPS",
      "service": "Priority",
      "rate": "7.58",
      "delivery_days": 2,
      "delivery_date": "2025-02-12"
    }
  ],
  "selected_rate": null,
  "postage_label": null,
  "tracking_code": null,
  "status": "unknown"
}
```

---

## Creating a Shipment

### Endpoint
```
POST https://api.easypost.com/v2/shipments
```

### Minimal Request (New Addresses)
```json
{
  "shipment": {
    "to_address": {
      "street1": "417 Montgomery Street",
      "city": "San Francisco",
      "state": "CA",
      "zip": "94104",
      "country": "US"
    },
    "from_address": {
      "street1": "388 Townsend St",
      "city": "San Francisco",
      "state": "CA",
      "zip": "94107",
      "country": "US"
    },
    "parcel": {
      "length": 10,
      "width": 8,
      "height": 4,
      "weight": 16
    }
  }
}
```

### Using Existing Address IDs
```json
{
  "shipment": {
    "to_address": { "id": "adr_xxx" },
    "from_address": { "id": "adr_yyy" },
    "parcel": {
      "length": 10,
      "width": 8,
      "height": 4,
      "weight": 16
    }
  }
}
```

---

## Parcel Object

### Dimensions
| Field | Type | Unit | Required |
|-------|------|------|----------|
| `length` | float | inches | Yes |
| `width` | float | inches | Yes |
| `height` | float | inches | Yes |
| `weight` | float | ounces | Yes |

### Predefined Packages
Instead of dimensions, you can use carrier-specific predefined packages:

```json
{
  "parcel": {
    "predefined_package": "FlatRateEnvelope",
    "weight": 10
  }
}
```

**Common Predefined Packages:**

| Carrier | Package | Typical Use |
|---------|---------|-------------|
| USPS | `FlatRateEnvelope` | Documents, small items |
| USPS | `SmallFlatRateBox` | Small items |
| USPS | `MediumFlatRateBox` | Medium items |
| USPS | `LargeFlatRateBox` | Large items |
| UPS | `UPSLetter` | Documents |
| UPS | `UPSExpressBox` | Small-medium items |
| FedEx | `FedExEnvelope` | Documents |
| FedEx | `FedExSmallBox` | Small items |

---

## Rate Object

```json
{
  "id": "rate_xxx",
  "object": "Rate",
  "carrier": "USPS",
  "carrier_account_id": "ca_xxx",
  "service": "Priority",
  "rate": "7.58",
  "currency": "USD",
  "retail_rate": "9.45",
  "list_rate": "8.25",
  "delivery_days": 2,
  "delivery_date": "2025-02-12T00:00:00Z",
  "delivery_date_guaranteed": false,
  "est_delivery_days": 2
}
```

### Key Rate Fields

| Field | Description |
|-------|-------------|
| `rate` | Your discounted rate (what you pay) |
| `retail_rate` | Post office / carrier retail price |
| `list_rate` | Published carrier rate |
| `delivery_days` | Estimated transit days |
| `delivery_date` | Estimated delivery date |
| `delivery_date_guaranteed` | Whether carrier guarantees date |

**Pricing Note**: You can charge customers `retail_rate` and pay `rate` to keep the margin, or pass through your cost.

---

## Buying a Label

### Endpoint
```
POST https://api.easypost.com/v2/shipments/{id}/buy
```

### Request
```json
{
  "rate": {
    "id": "rate_xxx"
  }
}
```

### Response (adds to Shipment)
```json
{
  "selected_rate": { /* the purchased rate */ },
  "postage_label": {
    "id": "pl_xxx",
    "label_url": "https://easypost-files.s3.amazonaws.com/xxx.png",
    "label_pdf_url": "https://easypost-files.s3.amazonaws.com/xxx.pdf",
    "label_zpl_url": "https://easypost-files.s3.amazonaws.com/xxx.zpl",
    "label_file_type": "image/png",
    "label_size": "4x6",
    "label_resolution": 300,
    "label_date": "2025-02-09T12:00:00Z"
  },
  "tracking_code": "9400111899223033005048",
  "tracker": {
    "id": "trk_xxx",
    "tracking_code": "9400111899223033005048",
    "status": "pre_transit",
    "public_url": "https://track.easypost.com/xxx"
  }
}
```

### Label Formats

| Format | Best For |
|--------|----------|
| PNG | Screen display |
| PDF | Printing (recommended) |
| ZPL | Thermal printers |

Request specific format with `label_format` parameter:
```json
{
  "rate": { "id": "rate_xxx" },
  "label_format": "PDF"
}
```

---

## Tracking

### Tracker Object
```json
{
  "id": "trk_xxx",
  "object": "Tracker",
  "mode": "test",
  "tracking_code": "9400111899223033005048",
  "status": "in_transit",
  "status_detail": "arrived_at_facility",
  "carrier": "USPS",
  "tracking_details": [
    {
      "datetime": "2025-02-09T14:00:00Z",
      "message": "Arrived at USPS facility",
      "status": "in_transit",
      "status_detail": "arrived_at_facility",
      "tracking_location": {
        "city": "San Francisco",
        "state": "CA",
        "zip": "94107"
      }
    }
  ],
  "est_delivery_date": "2025-02-12T00:00:00Z",
  "public_url": "https://track.easypost.com/xxx"
}
```

### Tracking Statuses

| Status | Meaning |
|--------|---------|
| `pre_transit` | Label created, not yet scanned |
| `in_transit` | Package is moving |
| `out_for_delivery` | On delivery vehicle |
| `delivered` | Package delivered |
| `return_to_sender` | Being returned |
| `failure` | Delivery failed |
| `unknown` | No information |

### Webhooks for Tracking
Instead of polling, set up webhooks to receive tracking updates:

```json
{
  "id": "evt_xxx",
  "object": "Event",
  "mode": "test",
  "description": "tracker.updated",
  "result": {
    /* Tracker object with latest status */
  }
}
```

---

## Common Carriers & Services

### USPS
| Service | Speed | Best For |
|---------|-------|----------|
| `First` | 2-5 days | Light packages (<13oz) |
| `Priority` | 1-3 days | General shipping |
| `Express` | 1-2 days | Urgent |
| `ParcelSelect` | 2-8 days | Heavy, not urgent |
| `GroundAdvantage` | 2-5 days | Replacing First & ParcelSelect |

### UPS
| Service | Speed | Best For |
|---------|-------|----------|
| `Ground` | 1-5 days | Cost-effective |
| `3DaySelect` | 3 days | Balanced |
| `2ndDayAir` | 2 days | Fast |
| `NextDayAir` | 1 day | Urgent |

### FedEx
| Service | Speed | Best For |
|---------|-------|----------|
| `FEDEX_GROUND` | 1-5 days | Cost-effective |
| `FEDEX_EXPRESS_SAVER` | 3 days | Balanced |
| `FEDEX_2_DAY` | 2 days | Fast |
| `PRIORITY_OVERNIGHT` | 1 day | Urgent |

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `SHIPMENT.INVALID_PARAMS` | Missing/invalid fields | Check required fields |
| `ADDRESS.VERIFICATION.FAILURE` | Bad address | Verify address first |
| `PARCEL.INVALID` | Bad dimensions | Check parcel values |
| `RATE.UNAVAILABLE` | No rates for route | Check addresses/parcel |

### Rate-Specific Errors
Sometimes a shipment is created but no rates are returned. Common causes:
- Parcel too heavy for service
- Origin/destination not served by carrier
- Hazmat restrictions
- PO Box (UPS/FedEx don't deliver to PO boxes)

---

## Best Practices for SendMo

### 1. Two-Step Rate Fetching
For SendMo's flow where buyer creates request before seller provides origin:

**Step 1 (Buyer)**: Create shipment with estimated from_address (or skip and fetch rates later)
**Step 2 (Seller)**: Update shipment with actual from_address, re-fetch rates

### 2. Rate Caching
- Rates are valid for short periods (typically 15-60 minutes)
- Store `rate.id` for purchase
- Re-fetch if user takes too long

### 3. Label Generation Timing
- Generate label only when seller is ready to print
- Labels can expire (varies by carrier)
- USPS labels are valid for longer than UPS/FedEx

### 4. Store Everything
- Store `shipment.id` for later operations
- Store `tracker.id` for tracking updates
- Store `postage_label.label_pdf_url` for reprints

### 5. Webhook Setup
Set up webhooks for:
- `tracker.created` - Label purchased
- `tracker.updated` - Status changes
- `shipment.invoice.created` - For reconciliation

---

## Test Mode

Test mode (`EASYPOST_API_KEY` starting with `EZTEST...`):
- Creates real-looking shipments
- Returns realistic rates
- Labels are marked "SAMPLE" and won't work
- Tracking simulates delivery over time

### Test Tracking
In test mode, trackers will automatically progress through statuses over several hours, simulating a real delivery.
