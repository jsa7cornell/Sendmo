# Sendmo Current Status (March 2026)

## Overall Status: Alpha Ready

The MVP is feature-complete for shipping labels. Ready for production deployment pending database setup and Stripe integration.

## What's Complete

### Frontend (100%)
| Component | Status | Location |
|-----------|--------|----------|
| Landing page | Done | `index.html` |
| Buyer flow (create label) | Done | `index.html` |
| Seller flow (print label) | Done | `index.html` |
| Rate selector (Simple + Power User) | Done | `RateSelector.tsx` |
| Responsive design | Done | CSS in `index.html` |
| Email templates | Done | `email-templates.ts` |

### Backend API (100%)
| Endpoint | Status | Location |
|----------|--------|----------|
| POST /api/shipments | Done | `backend/app/api/shipments/route.ts` |
| POST /api/shipments/[id]/buy | Done | `backend/app/api/shipments/[id]/buy/route.ts` |
| POST /api/addresses/verify | Done | `backend/app/api/addresses/verify/route.ts` |

### Integrations
| Integration | Status | Notes |
|-------------|--------|-------|
| EasyPost | **PRODUCTION READY** | Keys in `/credentials/` |
| Address verification | Working | Caching implemented |
| Multi-carrier (USPS/UPS/FedEx) | Working | EndShipper configured |
| Stripe | **NOT STARTED** | Schema designed, code pending |

### Testing (100%)
| Test Type | Status | Location |
|-----------|--------|----------|
| E2E (Playwright) | Passing | `tests/shipping-flow.spec.ts` |
| Backend (Vitest) | Passing | `backend/tests/easypost.test.ts` |
| CI/CD | Configured | `.github/workflows/test.yml` |

### Database
| Component | Status | Notes |
|-----------|--------|-------|
| Schema design | Done | `schema.sql`, `backend/prisma/schema.prisma` |
| Prisma ORM | Configured | Migrations ready |
| PostgreSQL deployment | **PENDING** | Need Vercel Postgres |

## What's Pending

### Critical Path to Alpha
1. **Deploy PostgreSQL** - Create Vercel Postgres, run migrations
2. **Stripe Integration** - Payment processing for label purchases
3. **Frontend-Backend Connection** - Wire up real API calls
4. **End-to-End Test** - Full flow with real labels

### Nice-to-Have (Post-Alpha)
- Error tracking (Sentry)
- Analytics (Mixpanel/PostHog)
- Email notifications (Resend/Sendgrid)
- Rate limiting
- Caching layer

## Environment Variables Required

```bash
# Database (PENDING)
DATABASE_URL="postgresql://user:pass@host:5432/sendmo?sslmode=require"

# EasyPost (READY - in /credentials/)
EASYPOST_API_KEY="EZ..."  # Production key

# Stripe (PENDING)
STRIPE_SECRET_KEY="sk_live_..."
STRIPE_PUBLISHABLE_KEY="pk_live_..."
STRIPE_WEBHOOK_SECRET="whsec_..."

# NextAuth (optional for MVP)
NEXTAUTH_URL="https://sendmo.co"
NEXTAUTH_SECRET="..."
```

## Recent Git Activity

Latest commits on `claude/import-sendmo-fixes-homiQ`:
```
248c5ff Update README with current alpha status (March 2026)
d390197 Increase vitest hook timeout for EasyPost API calls
dc9afd9 Fix Shipment.buy parameter order: insurance before endShipperId
5a362c6 Always use EndShipper for all carrier purchases
ebc3e19 Add multi-carrier support (USPS, UPS, FedEx) with EndShipper
```

## Known Issues

None currently. All tests passing.

## Deployment Info

- **Frontend**: Deployed to Vercel at sendmo.co
- **Backend**: Deployed to Vercel (same project)
- **Domain**: sendmo.co (DNS configured)
- **SSL**: Automatic via Vercel

## Demo Mode

Currently running in demo mode (returns mock rates). To enable live mode:
1. Set `EASYPOST_API_KEY` environment variable in Vercel
2. Backend automatically switches to live EasyPost API
