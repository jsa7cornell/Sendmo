# Sendmo Database Schema

## Schema Files

- **Raw SQL**: `/home/user/Sendmo/schema.sql` (349 lines, 10 tables)
- **Prisma ORM**: `/home/user/Sendmo/backend/prisma/schema.prisma` (323 lines)

Both schemas are aligned. Use Prisma for application code, raw SQL for reference.

## Core Tables

### users
User accounts (optional - sellers don't need accounts).
```sql
id              UUID PRIMARY KEY
email           VARCHAR(255) UNIQUE NOT NULL
stripe_customer_id VARCHAR(255)
created_at      TIMESTAMP DEFAULT NOW()
verification_status ENUM('unverified', 'email_verified', 'id_verified')
```

### shipping_requests (Main Transaction Table)
```sql
id              UUID PRIMARY KEY
share_token     VARCHAR(32) UNIQUE NOT NULL  -- Public URL token
status          ENUM('draft', 'pending_payment', 'paid', 'label_created',
                     'in_transit', 'delivered', 'cancelled', 'expired')

-- Addresses (foreign keys)
buyer_address_id    UUID REFERENCES addresses(id)
origin_address_id   UUID REFERENCES addresses(id)

-- Item info
item_description    TEXT
estimated_weight_oz INTEGER
package_size        ENUM('envelope', 'small', 'medium', 'large', 'custom')

-- Selected rate
selected_carrier    VARCHAR(50)
selected_service    VARCHAR(100)
selected_rate_cents INTEGER

-- EasyPost IDs
easypost_shipment_id VARCHAR(255)
easypost_rate_id     VARCHAR(255)
tracking_number      VARCHAR(100)
label_url           TEXT

-- Payment
payment_status      ENUM('pending', 'processing', 'completed', 'refunded', 'failed')
stripe_payment_intent_id VARCHAR(255)

-- Timestamps
created_at          TIMESTAMP DEFAULT NOW()
expires_at          TIMESTAMP  -- Auto-expire draft shipments
paid_at             TIMESTAMP
shipped_at          TIMESTAMP
delivered_at        TIMESTAMP
```

### addresses
Cached verified addresses (reduces EasyPost API calls).
```sql
id              UUID PRIMARY KEY
easypost_id     VARCHAR(255)  -- EasyPost address ID for reuse
street1         VARCHAR(255) NOT NULL
street2         VARCHAR(255)
city            VARCHAR(100) NOT NULL
state           VARCHAR(50) NOT NULL
zip             VARCHAR(20) NOT NULL
country         VARCHAR(2) DEFAULT 'US'
name            VARCHAR(255)
company         VARCHAR(255)
phone           VARCHAR(20)
verified        BOOLEAN DEFAULT FALSE
latitude        DECIMAL(10, 8)
longitude       DECIMAL(11, 8)
timezone        VARCHAR(50)
used_as_destination_count INTEGER DEFAULT 0
used_as_origin_count      INTEGER DEFAULT 0
```

### shipping_events
Tracking events from EasyPost webhooks.
```sql
id                  UUID PRIMARY KEY
shipping_request_id UUID REFERENCES shipping_requests(id)
event_type          ENUM('created', 'in_transit', 'out_for_delivery',
                         'delivered', 'return_to_sender', 'failure')
location            VARCHAR(255)
message             TEXT
easypost_tracker_id VARCHAR(255)
occurred_at         TIMESTAMP
created_at          TIMESTAMP DEFAULT NOW()
```

### notifications
Email/SMS delivery tracking.
```sql
id                  UUID PRIMARY KEY
shipping_request_id UUID REFERENCES shipping_requests(id)
type                ENUM('email', 'sms')
template            VARCHAR(100)  -- e.g., 'label_ready', 'shipped', 'delivered'
recipient           VARCHAR(255)
status              ENUM('pending', 'sent', 'delivered', 'bounced', 'failed')
sent_at             TIMESTAMP
opened_at           TIMESTAMP
clicked_at          TIMESTAMP
```

### payment_transactions
Detailed payment history for escrow.
```sql
id                  UUID PRIMARY KEY
shipping_request_id UUID REFERENCES shipping_requests(id)
type                ENUM('charge', 'hold', 'release', 'refund')
amount_cents        INTEGER NOT NULL
stripe_payment_intent_id VARCHAR(255)
stripe_charge_id    VARCHAR(255)
status              ENUM('pending', 'processing', 'completed', 'failed')
created_at          TIMESTAMP DEFAULT NOW()
```

### disputes
Buyer/seller dispute handling.
```sql
id                  UUID PRIMARY KEY
shipping_request_id UUID REFERENCES shipping_requests(id)
initiated_by        ENUM('buyer', 'seller')
reason              ENUM('not_received', 'damaged', 'wrong_item', 'other')
description         TEXT
status              ENUM('open', 'under_review', 'resolved', 'escalated')
resolution          TEXT
evidence_urls       TEXT[]  -- Array of uploaded evidence
created_at          TIMESTAMP DEFAULT NOW()
resolved_at         TIMESTAMP
```

### ratings
5-star review system.
```sql
id                  UUID PRIMARY KEY
shipping_request_id UUID REFERENCES shipping_requests(id)
rater_type          ENUM('buyer', 'seller')
rating              INTEGER CHECK (rating >= 1 AND rating <= 5)
tags                TEXT[]  -- e.g., ['fast_shipper', 'great_packaging']
review_text         TEXT
created_at          TIMESTAMP DEFAULT NOW()
```

### api_keys
For marketplace API integrations (Phase 3).
```sql
id              UUID PRIMARY KEY
user_id         UUID REFERENCES users(id)
key_hash        VARCHAR(255) NOT NULL  -- SHA-256 of API key
name            VARCHAR(100)
permissions     TEXT[]  -- e.g., ['create_shipments', 'read_tracking']
last_used_at    TIMESTAMP
expires_at      TIMESTAMP
created_at      TIMESTAMP DEFAULT NOW()
```

### audit_log
Security audit trail.
```sql
id              UUID PRIMARY KEY
user_id         UUID REFERENCES users(id)
action          VARCHAR(100) NOT NULL
resource_type   VARCHAR(50)
resource_id     UUID
old_value       JSONB
new_value       JSONB
ip_address      INET
user_agent      TEXT
created_at      TIMESTAMP DEFAULT NOW()
```

## Indexes

```sql
-- Fast share token lookup (most common query)
CREATE UNIQUE INDEX idx_shipping_requests_share_token ON shipping_requests(share_token);

-- Filter/sort shipments
CREATE INDEX idx_shipping_requests_status_created ON shipping_requests(status, created_at DESC);

-- Stripe customer lookup
CREATE INDEX idx_users_stripe_customer ON users(stripe_customer_id);

-- Address caching lookup
CREATE INDEX idx_addresses_lookup ON addresses(zip, verified) WHERE verified = true;
```

## Views

```sql
-- Active shipments (not expired, not delivered)
CREATE VIEW active_shipments AS
SELECT * FROM shipping_requests
WHERE status NOT IN ('delivered', 'cancelled', 'expired')
  AND (expires_at IS NULL OR expires_at > NOW());

-- Recent shipments with user info
CREATE VIEW recent_shipments_with_users AS
SELECT sr.*, u.email as buyer_email
FROM shipping_requests sr
LEFT JOIN users u ON sr.buyer_user_id = u.id
ORDER BY sr.created_at DESC
LIMIT 100;
```

## Prisma Generalized Request Model

The Prisma schema uses a more generalized `Request` model to support future escrow/services:

```prisma
model Request {
  id          String   @id @default(cuid())
  requestType RequestType  // shipping, escrow, local_pickup, digital, service

  // Generic fields
  title       String?
  description String?

  // Participants
  payerUserId     String?
  payerEmail      String
  providerUserId  String?
  providerEmail   String?

  // Shipping-specific
  destinationAddressId String?
  originAddressId      String?
  estimatedPackageSize PackageSize?
  selectedCarrier      String?
  selectedService      String?

  // Payment
  paymentStatus       PaymentStatus @default(PENDING)
  paymentAmountCents  Int?
  stripePaymentIntentId String?

  // ... more fields
}
```

This allows the same table to handle shipping, escrow, and other transaction types.
