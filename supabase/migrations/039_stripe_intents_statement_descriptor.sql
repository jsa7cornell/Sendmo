-- 039: Persist the Stripe statement descriptor suffix on stripe_intents.
--
-- Why: the suffix printed on cardholder statements ("SENDMO* <suffix>") is
-- set at PI creation from the flex link short_code (labels), the shipment
-- public_code (adjustment recharges), or the literal "LABEL" (on-session
-- full-label). Flex short_codes can rotate and links can be deleted, so the
-- value on the statement is a point-in-time snapshot that may match nothing
-- in the database later — support could not resolve "SENDMO* C4HLV3UFUB"
-- back to a transaction. Storing it on the PI mirror makes the statement
-- line durably queryable regardless of later link rotation.
--
-- Support lookup (statements print the suffix uppercased):
--   select * from stripe_intents
--   where upper(statement_descriptor_suffix) = upper('<suffix from statement>');

alter table public.stripe_intents
    add column if not exists statement_descriptor_suffix text;

comment on column public.stripe_intents.statement_descriptor_suffix is
    'Snapshot of the PI statement_descriptor_suffix ("SENDMO* <this>" on card statements). Set by stripe-webhook from the PI object. Case-preserved; statements uppercase it, so query with upper().';

create index if not exists stripe_intents_statement_descriptor_suffix_idx
    on public.stripe_intents (upper(statement_descriptor_suffix))
    where statement_descriptor_suffix is not null;
