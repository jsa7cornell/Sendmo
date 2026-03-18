# Sendmo Alpha Launch Checklist

## Overview

This checklist covers all tasks needed to launch Sendmo alpha at sendmo.co with real shipping labels.

## Workstream 1: Database Deployment

### Tasks
- [ ] Create Vercel Postgres database
- [ ] Get DATABASE_URL connection string
- [ ] Add DATABASE_URL to Vercel environment variables
- [ ] Run `npx prisma migrate deploy` in backend
- [ ] Verify all tables created correctly
- [ ] Test database connection from API routes
- [ ] Seed any required initial data

### Verification
- [ ] Can create a test shipping request in database
- [ ] Can query shipping requests
- [ ] Prisma client connects without errors

---

## Workstream 2: Stripe Integration

### Tasks
- [ ] Create/access Stripe account
- [ ] Get production API keys (sk_live_, pk_live_)
- [ ] Add Stripe keys to Vercel environment variables
- [ ] Create `/api/payments/create-intent` endpoint
- [ ] Create `/api/payments/confirm` endpoint
- [ ] Create `/api/webhooks/stripe` endpoint
- [ ] Configure Stripe webhook in Stripe Dashboard
- [ ] Update `/api/shipments/[id]/buy` to require payment
- [ ] Test payment flow with Stripe test mode first

### Verification
- [ ] Can create payment intent
- [ ] Can complete payment
- [ ] Webhook receives events
- [ ] Label purchase blocked without payment

---

## Workstream 3: Frontend-Backend Integration

### Tasks
- [ ] Audit `index.html` for mock data usage
- [ ] Replace mock rate fetching with `POST /api/shipments`
- [ ] Replace mock label purchase with `POST /api/shipments/[id]/buy`
- [ ] Add address verification call to `POST /api/addresses/verify`
- [ ] Add Stripe.js for payment form
- [ ] Implement proper loading states
- [ ] Implement error handling and user feedback
- [ ] Configure API base URL for production

### Verification
- [ ] Frontend fetches real rates from EasyPost
- [ ] Address verification works
- [ ] Payment flow completes
- [ ] Label URL displays correctly

---

## Workstream 4: Frontend Polish

### Tasks
- [ ] Walk through complete buyer flow
- [ ] Walk through complete seller flow
- [ ] Test on mobile viewport (iPhone 13)
- [ ] Test on tablet viewport
- [ ] Verify all loading states
- [ ] Verify all error states
- [ ] Check accessibility (color contrast, focus states)
- [ ] Verify share link generation
- [ ] Test label printing

### Verification
- [ ] No console errors
- [ ] All interactions work
- [ ] Responsive on all viewports

---

## Workstream 5: Production Environment

### Tasks
- [ ] Verify sendmo.co DNS configuration
- [ ] Verify SSL certificate active
- [ ] Set EASYPOST_API_KEY in Vercel (production key from /credentials/)
- [ ] Set all Stripe keys in Vercel
- [ ] Set DATABASE_URL in Vercel
- [ ] Configure EasyPost webhook URL
- [ ] Configure Stripe webhook URL
- [ ] Deploy latest code to Vercel
- [ ] Verify deployment successful

### Verification
- [ ] https://sendmo.co loads
- [ ] API routes respond
- [ ] No environment variable errors in logs

---

## Final Verification: End-to-End Test

### Test Scenario
1. [ ] Go to sendmo.co
2. [ ] Create a new shipping label as buyer
3. [ ] Enter real addresses
4. [ ] Select a shipping rate
5. [ ] Complete payment
6. [ ] Get share link
7. [ ] Open share link as seller
8. [ ] View and "print" label
9. [ ] Verify tracking number exists
10. [ ] Verify label PDF downloads

### Success Criteria
- [ ] Real EasyPost rates displayed
- [ ] Real payment processed
- [ ] Real shipping label generated
- [ ] Real tracking number assigned
- [ ] No errors in flow

---

## Post-Launch (Nice-to-Have)

- [ ] Set up Sentry for error tracking
- [ ] Set up analytics (Mixpanel/PostHog)
- [ ] Configure email notifications (Resend)
- [ ] Add rate limiting to API
- [ ] Monitor first 10 transactions
- [ ] Gather user feedback
