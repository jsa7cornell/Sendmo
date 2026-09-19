-- 050: shipments.link_id ON DELETE CASCADE → RESTRICT.
--
-- PR11 review finding #1 (seller-link launch): migration 001 created the FK
-- with ON DELETE CASCADE — meaning deleting a sendmo_links row silently
-- deletes its PAID shipments. That was never load-bearing (nothing deleted
-- links) until PR11's throwaway-link cleanup added the repo's first
-- .delete(). A shipment row is the record of money moved and a label sold;
-- no link deletion should ever be able to take one with it. RESTRICT makes
-- the delete fail loudly instead — exactly the fail-closed behavior PR11's
-- cleanup wants (it only deletes a throwaway AFTER verifying the shipment
-- was repointed away from it).

ALTER TABLE public.shipments
    DROP CONSTRAINT IF EXISTS shipments_link_id_fkey;
ALTER TABLE public.shipments
    ADD CONSTRAINT shipments_link_id_fkey
    FOREIGN KEY (link_id) REFERENCES public.sendmo_links(id) ON DELETE RESTRICT;
