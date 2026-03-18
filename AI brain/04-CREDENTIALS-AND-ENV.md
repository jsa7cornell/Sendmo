# Sendmo Credentials & Environment

## Credential Storage

**Location**: `/home/user/Sendmo/credentials/` (gitignored)

### EasyPost Production
- **Status**: READY
- **File**: `credentials/easypost-prod.json`
- **Usage**: Multi-carrier shipping (USPS, UPS, FedEx)
- **Features**: Address verification, rate quotes, label generation, tracking

### Stripe
- **Status**: PENDING SETUP
- **Required Keys**:
  - `STRIPE_SECRET_KEY` (sk_live_...)
  - `STRIPE_PUBLISHABLE_KEY` (pk_live_...)
  - `STRIPE_WEBHOOK_SECRET` (whsec_...)
- **Usage**: Payment processing for label purchases

### Database
- **Status**: PENDING SETUP
- **Required**: Vercel Postgres connection string
- **Format**: `postgresql://user:pass@host:5432/sendmo?sslmode=require`

## Environment Variables

### Required for Production

```bash
# Database
DATABASE_URL="postgresql://..."

# EasyPost (shipping)
EASYPOST_API_KEY="EZ..."

# Stripe (payments)
STRIPE_SECRET_KEY="sk_live_..."
STRIPE_PUBLISHABLE_KEY="pk_live_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
```

### Optional

```bash
# Authentication (optional for MVP)
NEXTAUTH_URL="https://sendmo.co"
NEXTAUTH_SECRET="..."

# Monitoring (post-alpha)
SENTRY_DSN="..."

# Analytics (post-alpha)
MIXPANEL_TOKEN="..."
```

## Vercel Environment Setup

1. Go to Vercel Dashboard > Sendmo project
2. Settings > Environment Variables
3. Add each variable for Production environment
4. Redeploy to apply changes

## Local Development

Create `.env.local` in `/backend/`:
```bash
DATABASE_URL="postgresql://localhost:5432/sendmo_dev"
EASYPOST_API_KEY="EZTK..."  # Test key for development
```

## Security Notes

- Never commit credentials to git
- Use Vercel's encrypted environment variables
- Rotate keys periodically
- EasyPost test vs production keys have different prefixes
