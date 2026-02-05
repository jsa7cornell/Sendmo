-- SendMo Database Schema
-- PostgreSQL

-- Users Table
-- Optional accounts for both buyers and sellers (recommended but not required)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    phone VARCHAR(50),
    
    -- Auth
    password_hash VARCHAR(255), -- for email/password auth
    google_id VARCHAR(255) UNIQUE, -- for Google OAuth
    
    -- Verification States
    -- unverified: just created, email not verified
    -- linked: clicked a link we sent (tracking, notification, etc.) - implicit verification
    -- verified: explicitly verified via email verification link
    verification_status VARCHAR(50) DEFAULT 'unverified', -- unverified, linked, verified
    verified_at TIMESTAMP,
    verification_method VARCHAR(50), -- 'email_link', 'tracking_click', 'notification_click', 'google_oauth'
    
    -- Stripe
    stripe_customer_id VARCHAR(255) UNIQUE,
    stripe_payment_method_id VARCHAR(255), -- saved card
    
    -- Preferences
    default_shipping_address JSONB, -- {street, city, state, zip, country}
    notification_preferences JSONB DEFAULT '{"email": true, "sms": false}',
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_login_at TIMESTAMP,
    
    -- Stats (denormalized for quick access)
    total_shipments_sent INT DEFAULT 0, -- as sender
    total_shipments_received INT DEFAULT 0, -- as receiver
    total_spent_cents INT DEFAULT 0
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_stripe_customer ON users(stripe_customer_id);

-- Shipping Requests Table
-- Core table: each row = one shipping label request
CREATE TABLE shipping_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_token VARCHAR(50) UNIQUE NOT NULL, -- for public link (sendmo.co/ship/abc123)
    
    -- Buyer (receiver) info
    buyer_user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- nullable: buyer might not have account
    buyer_email VARCHAR(255), -- for notifications even without account
    buyer_name VARCHAR(255),
    
    -- Destination (where package is going - buyer's address)
    destination_address JSONB NOT NULL, -- {street, city, state, zip, country}
    destination_name VARCHAR(255), -- recipient name
    
    -- Origin (where package ships from - seller's address)
    origin_address JSONB, -- nullable until seller fills it in
    origin_city VARCHAR(255), -- pre-filled if buyer knows seller's city
    sender_name VARCHAR(255),
    sender_email VARCHAR(255), -- for notifications if seller provides
    sender_phone VARCHAR(255),
    
    -- Package details
    item_description TEXT NOT NULL,
    
    -- Estimated (what receiver thinks it will be)
    estimated_package_size VARCHAR(50) NOT NULL, -- 'envelope', 'small', 'medium', 'large', 'custom'
    estimated_package_dimensions JSONB, -- {length, width, height, unit} in inches
    estimated_package_weight_oz INT, -- weight in ounces
    
    -- Actual (what sender confirms it is)
    actual_package_size VARCHAR(50), -- set when sender completes
    actual_package_dimensions JSONB,
    actual_package_weight_oz INT,
    
    -- If actual differs significantly from estimated, flag for review
    size_mismatch BOOLEAN DEFAULT FALSE,

    -- Shipping selection
    selected_carrier VARCHAR(50), -- 'USPS', 'UPS', 'FedEx', etc.
    selected_service VARCHAR(100), -- 'Priority Mail', 'Ground', etc.
    selected_speed VARCHAR(50), -- 'overnight', 'medium', 'slow' - for UI
    estimated_shipping_cost_cents INT, -- estimated cost shown to receiver
    actual_shipping_cost_cents INT, -- actual cost after sender confirms size
    shipping_cost_paid_cents INT, -- what was actually charged
    estimated_delivery_days INT,
    
    -- EasyPost integration
    easypost_shipment_id VARCHAR(255) UNIQUE,
    easypost_rate_id VARCHAR(255),
    easypost_tracker_id VARCHAR(255),
    label_url TEXT, -- URL to download PDF label
    tracking_number VARCHAR(255),
    
    -- Status tracking
    status VARCHAR(50) DEFAULT 'pending', -- pending, label_generated, in_transit, delivered, cancelled, error
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    label_generated_at TIMESTAMP,
    shipped_at TIMESTAMP,
    delivered_at TIMESTAMP,
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '7 days', -- link expires after 7 days if unused
    
    -- Payment (for Phase 2 - escrow)
    payment_status VARCHAR(50) DEFAULT 'unpaid', -- unpaid, paid, held, released, refunded
    payment_amount_cents INT, -- total: item_price + shipping
    item_price_cents INT, -- item cost (for escrow feature)
    stripe_payment_intent_id VARCHAR(255),
    stripe_charge_id VARCHAR(255),
    payment_released_at TIMESTAMP,
    
    -- Metadata
    user_agent TEXT,
    ip_address INET,
    referral_source VARCHAR(255) -- where did buyer come from
);

CREATE INDEX idx_shipping_requests_share_token ON shipping_requests(share_token);
CREATE INDEX idx_shipping_requests_buyer_user ON shipping_requests(buyer_user_id);
CREATE INDEX idx_shipping_requests_status ON shipping_requests(status);
CREATE INDEX idx_shipping_requests_created ON shipping_requests(created_at DESC);
CREATE INDEX idx_shipping_requests_tracking ON shipping_requests(tracking_number);

-- Shipping Events Table
-- Track all status changes for shipping requests
CREATE TABLE shipping_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipping_request_id UUID NOT NULL REFERENCES shipping_requests(id) ON DELETE CASCADE,
    
    event_type VARCHAR(100) NOT NULL, -- 'label_created', 'label_printed', 'in_transit', 'out_for_delivery', 'delivered', etc.
    event_status VARCHAR(50), -- carrier status code
    event_message TEXT, -- human-readable description
    location VARCHAR(255), -- where event occurred
    
    -- Source
    source VARCHAR(50) DEFAULT 'easypost', -- 'easypost', 'manual', 'system'
    
    -- EasyPost data
    easypost_tracker_id VARCHAR(255),
    carrier_code VARCHAR(50),
    raw_data JSONB, -- full webhook payload
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_shipping_events_request ON shipping_events(shipping_request_id);
CREATE INDEX idx_shipping_events_created ON shipping_events(created_at DESC);

-- Notifications Table
-- Track emails/SMS sent to users
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipping_request_id UUID REFERENCES shipping_requests(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    
    notification_type VARCHAR(50) NOT NULL, -- 'email', 'sms'
    recipient_email VARCHAR(255),
    recipient_phone VARCHAR(50),
    
    template_name VARCHAR(100) NOT NULL, -- 'label_created', 'label_viewed', 'shipped', 'delivered'
    subject VARCHAR(255),
    
    status VARCHAR(50) DEFAULT 'pending', -- pending, sent, failed, bounced
    
    -- Provider info
    provider VARCHAR(50), -- 'sendgrid', 'twilio', etc.
    provider_message_id VARCHAR(255),
    
    sent_at TIMESTAMP,
    opened_at TIMESTAMP, -- email open tracking
    clicked_at TIMESTAMP, -- link click tracking
    
    error_message TEXT,
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_request ON notifications(shipping_request_id);
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_status ON notifications(status);

-- Payment Transactions Table (Phase 2)
-- Track all payment operations for escrow
CREATE TABLE payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipping_request_id UUID NOT NULL REFERENCES shipping_requests(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    
    transaction_type VARCHAR(50) NOT NULL, -- 'charge', 'hold', 'release', 'refund'
    amount_cents INT NOT NULL,
    
    -- Stripe
    stripe_payment_intent_id VARCHAR(255),
    stripe_charge_id VARCHAR(255),
    stripe_refund_id VARCHAR(255),
    
    status VARCHAR(50) DEFAULT 'pending', -- pending, succeeded, failed, cancelled
    
    -- Metadata
    description TEXT,
    metadata JSONB,
    
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

CREATE INDEX idx_payment_transactions_request ON payment_transactions(shipping_request_id);
CREATE INDEX idx_payment_transactions_user ON payment_transactions(user_id);

-- Disputes Table (Phase 3)
-- Handle issues between buyers and sellers
CREATE TABLE disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipping_request_id UUID NOT NULL REFERENCES shipping_requests(id) ON DELETE CASCADE,
    
    opened_by VARCHAR(50) NOT NULL, -- 'buyer' or 'seller'
    dispute_type VARCHAR(100) NOT NULL, -- 'item_not_received', 'item_damaged', 'wrong_item', 'refund_request'
    
    description TEXT NOT NULL,
    evidence_urls TEXT[], -- links to uploaded photos/documents
    
    status VARCHAR(50) DEFAULT 'open', -- open, investigating, resolved, closed
    resolution VARCHAR(50), -- 'refunded', 'reshipped', 'no_action', 'favor_buyer', 'favor_seller'
    resolution_notes TEXT,
    
    -- Admin handling
    assigned_to VARCHAR(255), -- admin email
    
    created_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_disputes_request ON disputes(shipping_request_id);
CREATE INDEX idx_disputes_status ON disputes(status);

-- Ratings Table (Phase 3)
-- Buyer rates seller, seller rates buyer
CREATE TABLE ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipping_request_id UUID NOT NULL REFERENCES shipping_requests(id) ON DELETE CASCADE,
    
    rater_type VARCHAR(50) NOT NULL, -- 'buyer' or 'seller'
    rater_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review_text TEXT,
    
    -- What went well / what could improve
    tags TEXT[], -- ['fast_shipping', 'good_communication', 'item_as_described', etc.]
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ratings_request ON ratings(shipping_request_id);
CREATE INDEX idx_ratings_user ON ratings(rater_user_id);

-- API Keys Table (for future marketplace integrations)
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    key_hash VARCHAR(255) NOT NULL UNIQUE, -- hashed API key
    key_prefix VARCHAR(20) NOT NULL, -- first few chars for display (e.g., "sk_live_abc...")
    
    name VARCHAR(255), -- user-given name like "My Store Integration"
    
    permissions TEXT[] DEFAULT ARRAY['create_shipment', 'view_shipment'], -- what this key can do
    
    last_used_at TIMESTAMP,
    
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- Audit Log Table
-- Track all important actions for security/debugging
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    shipping_request_id UUID REFERENCES shipping_requests(id) ON DELETE SET NULL,
    
    action VARCHAR(100) NOT NULL, -- 'user.login', 'label.created', 'payment.charged', etc.
    resource_type VARCHAR(50), -- 'user', 'shipping_request', 'payment', etc.
    resource_id UUID,
    
    ip_address INET,
    user_agent TEXT,
    
    details JSONB, -- additional context
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_log_action ON audit_log(action);

-- Functions and Triggers

-- Update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_disputes_updated_at BEFORE UPDATE ON disputes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Views for common queries

-- Active shipping requests (not expired, not delivered)
CREATE VIEW active_shipments AS
SELECT 
    sr.*,
    u.email as buyer_email_from_user,
    u.name as buyer_name_from_user
FROM shipping_requests sr
LEFT JOIN users u ON sr.buyer_user_id = u.id
WHERE sr.status NOT IN ('delivered', 'cancelled')
  AND sr.expires_at > NOW();

-- Recent shipments with user info
CREATE VIEW recent_shipments_with_users AS
SELECT 
    sr.*,
    u.email as buyer_email,
    u.name as buyer_name
FROM shipping_requests sr
LEFT JOIN users u ON sr.buyer_user_id = u.id
ORDER BY sr.created_at DESC
LIMIT 100;
