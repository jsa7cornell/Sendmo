# EasyPost Address API Reference

> **Source**: EasyPost API Documentation
> **Relevant for**: Address verification, label generation
> **API Version**: v2

---

## Overview

EasyPost's Address API handles address creation, verification, and storage. Every shipment requires valid `to_address` and `from_address` objects.

---

## Address Object

```json
{
  "id": "adr_xxx",
  "object": "Address",
  "mode": "test",
  "street1": "417 Montgomery Street",
  "street2": "Floor 5",
  "city": "San Francisco",
  "state": "CA",
  "zip": "94104",
  "country": "US",
  "residential": false,
  "carrier_facility": null,
  "name": "John Smith",
  "company": "EasyPost",
  "phone": "415-123-4567",
  "email": "support@easypost.com",
  "federal_tax_id": null,
  "state_tax_id": null,
  "verifications": {
    "zip4": {
      "success": true,
      "errors": [],
      "details": {
        "zip4": "1234"
      }
    },
    "delivery": {
      "success": true,
      "errors": [],
      "details": {
        "latitude": 37.7749,
        "longitude": -122.4194,
        "time_zone": "America/Los_Angeles"
      }
    }
  }
}
```

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (starts with `adr_`) |
| `street1` | string | Primary street address |
| `street2` | string | Apt, suite, unit, etc. |
| `city` | string | City name |
| `state` | string | 2-letter state code |
| `zip` | string | ZIP or postal code |
| `country` | string | 2-letter country code (default: US) |
| `residential` | boolean | Whether address is residential |
| `verifications` | object | Verification results |

---

## Creating an Address

### Endpoint
```
POST https://api.easypost.com/v2/addresses
```

### Request Body
```json
{
  "address": {
    "street1": "417 Montgomery Street",
    "street2": "Floor 5",
    "city": "San Francisco",
    "state": "CA",
    "zip": "94104",
    "country": "US",
    "name": "John Smith",
    "phone": "415-123-4567",
    "email": "john@example.com"
  }
}
```

### With Verification
```json
{
  "address": {
    "street1": "417 Montgomery Street",
    "city": "San Francisco",
    "state": "CA",
    "zip": "94104",
    "country": "US"
  },
  "verify": ["delivery"]
}
```

### Verification Options

| Option | Description |
|--------|-------------|
| `delivery` | Full address verification (recommended) |
| `zip4` | Only verify and append ZIP+4 |

**Note**: `verify_strict` will fail if address can't be verified. `verify` will return the address with verification errors but won't fail.

---

## Verification Response

### Successful Verification
```json
{
  "verifications": {
    "delivery": {
      "success": true,
      "errors": [],
      "details": {
        "latitude": 37.7749,
        "longitude": -122.4194,
        "time_zone": "America/Los_Angeles"
      }
    }
  }
}
```

### Failed Verification
```json
{
  "verifications": {
    "delivery": {
      "success": false,
      "errors": [
        {
          "code": "E.ADDRESS.NOT_FOUND",
          "field": "address",
          "message": "Address not found"
        }
      ],
      "details": null
    }
  }
}
```

### Common Error Codes

| Code | Meaning |
|------|---------|
| `E.ADDRESS.NOT_FOUND` | Address does not exist |
| `E.SECONDARY_INFORMATION.INVALID` | Invalid apt/suite number |
| `E.SECONDARY_INFORMATION.MISSING` | Missing apt/suite number |
| `E.HOUSE_NUMBER.MISSING` | Street number is missing |
| `E.HOUSE_NUMBER.INVALID` | Street number is invalid |
| `E.STREET.MISSING` | Street name is missing |
| `E.BOX_NUMBER.MISSING` | PO Box number missing |
| `E.BOX_NUMBER.INVALID` | PO Box number invalid |
| `E.ADDRESS.INVALID` | General invalid address |

---

## Address Correction

EasyPost will correct minor errors in addresses. The corrected address is returned in the response.

**Example**: Input "123 Main St, San Fran, CA" might return:
```json
{
  "street1": "123 Main St",
  "city": "San Francisco",
  "state": "CA",
  "zip": "94102"
}
```

Always use the **returned values**, not the input values, for shipping labels.

---

## Best Practices for SendMo

### 1. Always Verify Before Storing
```javascript
const response = await easypost.Address.create({
  ...addressData,
  verify: ['delivery']
});

if (!response.verifications?.delivery?.success) {
  // Handle verification failure
  const errors = response.verifications?.delivery?.errors || [];
  // Show errors to user for correction
}
```

### 2. Cache Verified Addresses
- Store the `id` (e.g., `adr_xxx`) from EasyPost
- Reuse for repeat shipments
- Reduces API calls and improves speed

### 3. Handle Partial Verification
- An address can be created but fail verification
- Show the corrected address to users
- Let them confirm or edit

### 4. Residential Flag
- Important for UPS/FedEx pricing
- Residential addresses have surcharges
- EasyPost sets this automatically during verification

---

## Test Mode

In test mode (`EASYPOST_API_KEY` starting with `EZTEST...`):
- Addresses are created but not billed
- Verification may return different results than production
- Use these test addresses:

### Test Addresses
```javascript
// Valid address
{
  street1: "388 Townsend St",
  city: "San Francisco",
  state: "CA",
  zip: "94107"
}

// Invalid address (will fail verification)
{
  street1: "INVALID ADDRESS",
  city: "San Francisco",
  state: "CA",
  zip: "00000"
}
```

---

## Rate Limits

- 100 requests/second for address creation
- Cached addresses don't count against limits
- Use batch operations for multiple addresses

---

## Integration Notes for SendMo

1. **Buyer address**: Verify on entry, store verified version
2. **Seller address**: Verify when they enter origin address
3. **Show corrections**: If EasyPost corrects the address, show the user
4. **Store EasyPost ID**: Cache `adr_xxx` for reuse in shipment creation
5. **Graceful degradation**: If verification fails but address was created, allow proceeding with warning
