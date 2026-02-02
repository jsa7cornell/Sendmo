# SendMo - Ship it, trust it

Marketplace shipping made simple. Buyers create labels, sellers print and ship.

## What is SendMo?

SendMo solves the #1 friction point in peer-to-peer marketplace transactions: shipping. Instead of coordinating addresses, payment methods, and label creation, buyers simply:

1. Create a shipping label with SendMo
2. Share a link with the seller
3. Seller clicks, prints, ships

Buyer pays shipping upfront. Seller gets a ready-to-print label. No accounts needed for sellers.

## Current Status: MVP / Demo Mode

This is a functional prototype with:
- ✅ Full UI/UX flow (buyer + seller)
- ✅ Mock shipping rates
- ✅ Shareable links
- ✅ Label printing
- 🚧 **Awaiting EasyPost API approval for real labels**
- 🚧 Stripe integration pending

## Tech Stack

- React 18 (standalone, no build step for now)
- Vanilla CSS (custom design system)
- Will add: Next.js, EasyPost API, Stripe

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

## Next Steps

1. ✅ Deploy to sendmo.co
2. ⏳ Wait for EasyPost approval (~24-48 hrs)
3. 🔜 Add real shipping rates + label generation
4. 🔜 Stripe payment integration
5. 🔜 Backend API (Next.js API routes)
6. 🔜 Database (PostgreSQL)

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
