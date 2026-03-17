# SendMo - Ship it, trust it

Marketplace shipping made simple. Buyers create labels, sellers print and ship.

## What is SendMo?

SendMo solves the #1 friction point in peer-to-peer marketplace transactions: shipping. Instead of coordinating addresses, payment methods, and label creation, buyers simply:

1. Create a shipping label with SendMo
2. Share a link with the seller
3. Seller clicks, prints, ships

Buyer pays shipping upfront. Seller gets a ready-to-print label. No accounts needed for sellers.

## Current Status: Alpha Ready (March 2026)

### Completed
- ✅ Full UI/UX flow (buyer creates label → shares link → seller prints/ships)
- ✅ React 18 frontend (`index.html`, `RateSelector.tsx`)
- ✅ Next.js 14 backend API (`/backend/app/api/`)
- ✅ EasyPost integration (address verification, multi-carrier rates, label purchase)
- ✅ Multi-carrier support: USPS, UPS, FedEx via EndShipper
- ✅ E2E tests (Playwright) + Backend tests (Vitest) - all passing
- ✅ CI/CD pipeline (GitHub Actions with auto-fix)
- ✅ **EasyPost production API keys ready** (`/credentials/`)

### Pending for Alpha Launch
- 🔜 Deploy PostgreSQL database (Vercel Postgres)
- 🔜 Run Prisma migrations (schema ready at `backend/prisma/schema.prisma`)
- 🔜 Stripe payment integration (schema designed, code pending)
- 🔜 Connect frontend to live backend API

### Documentation
- `AI_FEATURE_SPEC.md` - GPT-4 Vision item recognition (future feature)
- `schema.sql` - Full PostgreSQL DDL (10 tables)
- `backend/prisma/schema.prisma` - ORM schema with generalized Request model

## Tech Stack

- **Frontend**: React 18 (standalone), Vanilla CSS, Playwright tests
- **Backend**: Next.js 14 API routes, Prisma ORM, Zod validation
- **Integrations**: EasyPost (shipping), Stripe (payments - pending)
- **Database**: PostgreSQL (schema ready, deployment pending)

## Quick Deploy to Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. In this directory: `vercel`
3. Point your domain (sendmo.co) to Vercel

Or deploy via Vercel dashboard:
1. Go to vercel.com
2. Import this project
3. Set custom domain to sendmo.co
4. Deploy!

## Domain Setup

1. Go to your domain registrar (where you bought sendmo.co)
2. Add DNS records provided by Vercel:
   - Type: A, Name: @, Value: 76.76.21.21
   - Type: CNAME, Name: www, Value: cname.vercel-dns.com

## Next Steps (Alpha Launch)

1. ✅ Deploy frontend to sendmo.co
2. ✅ Backend API routes built (shipments, addresses)
3. ✅ EasyPost production keys obtained
4. 🔜 **Deploy Vercel Postgres + run migrations**
5. 🔜 **Stripe payment integration**
6. 🔜 **Connect frontend to production backend**
7. 🔜 End-to-end test with real shipping labels

## Test the App Locally

Just open `index.html` in a browser. Everything works client-side for now.

## Product Vision

**Phase 1 (Current):** Shipping labels
- Buyer pays for shipping
- Seller prints label
- Track shipments

**Phase 2:** Payment escrow
- Add "Pay $X + shipping" button
- Hold payment until delivery
- Release on confirmation

**Phase 3:** Full trust platform
- Ratings/reviews
- Dispute resolution
- Identity verification

## Design Philosophy

SendMo should feel:
- **Trustworthy** - Dark, professional aesthetic (not startup-playful)
- **Fast** - Minimal steps, no friction
- **Clear** - Every action has obvious next step

Inspired by: Stripe's clarity, Linear's speed, Coinbase's trust.

---

Built with ❤️ for marketplace sellers everywhere
