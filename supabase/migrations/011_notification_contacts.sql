-- =============================================================
-- SendMo — Notification Contacts & Log
-- Migration: 011_notification_contacts.sql
-- Extensible notification system: supports email now, SMS/push later.
-- =============================================================

-- Who should be notified about a shipment
CREATE TABLE public.notification_contacts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id UUID NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('sender', 'recipient')),
    channel     TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
    address     TEXT NOT NULL,  -- email address, phone number, or push token
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notification_contacts IS 'Contacts to notify about shipment events. Extensible: email now, SMS/push later.';

CREATE INDEX idx_notification_contacts_shipment
    ON public.notification_contacts (shipment_id);

-- Audit trail: what was sent, when, success/failure
CREATE TABLE public.notifications_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id   UUID NOT NULL REFERENCES public.shipments(id),
    contact_id    UUID REFERENCES public.notification_contacts(id),
    channel       TEXT NOT NULL,
    event_type    TEXT NOT NULL,  -- 'in_transit', 'delivered', 'label_created', etc.
    status        TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'skipped')),
    provider_id   TEXT,           -- resend message ID, twilio SID, etc.
    error_message TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notifications_log IS 'Audit log for all notification send attempts.';

CREATE INDEX idx_notifications_log_shipment
    ON public.notifications_log (shipment_id);

-- Unique constraint for idempotency: don't send same event to same contact twice
CREATE UNIQUE INDEX idx_notifications_log_idempotent
    ON public.notifications_log (shipment_id, contact_id, event_type)
    WHERE status = 'sent';

-- RLS: accessed via service role only
ALTER TABLE public.notification_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications_log ENABLE ROW LEVEL SECURITY;
