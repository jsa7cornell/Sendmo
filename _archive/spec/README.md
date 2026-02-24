# SendMo Specification

This folder contains the product specification and reference documentation for SendMo.

## Structure

```
spec/
├── README.md              # This file
├── SPEC.md                # Main product specification
├── external-docs/         # Third-party API documentation
│   ├── easypost-addresses.md
│   ├── easypost-shipments.md
│   ├── stripe-connect.md
│   └── stripe-checkout.md
└── decisions/             # Architecture Decision Records (ADRs)
    └── 001-data-model.md
```

## Usage with AI Services

This folder is designed to be consumed by multiple AI services:

| Service | How to Use |
|---------|------------|
| **Google Gemini** | Link Google Drive, access directly |
| **NotebookLM** | Add this folder as a source |
| **Claude Code** | Reads/writes directly |
| **Claude.ai** | Upload to a Project |
| **ChatGPT** | Upload files to conversation |

## Files

### SPEC.md
The main product specification including:
- Product vision and target users
- MVP scope and features
- User flows (buyer and seller)
- Pricing model
- Technical requirements
- Future phases

### external-docs/
Reference documentation for third-party integrations:
- **easypost-addresses.md**: Address verification API
- **easypost-shipments.md**: Shipping labels and tracking
- **stripe-connect.md**: Marketplace payments (Phase 2)
- **stripe-checkout.md**: MVP payment flow

### decisions/
Architecture Decision Records documenting key technical choices:
- **001-data-model.md**: Generalized Request model design

## Editing Guidelines

1. **SPEC.md**: Edit freely to evolve product requirements
2. **external-docs/**: Update when API changes or new integrations added
3. **decisions/**: Add new ADRs as `NNN-title.md`, don't modify accepted ones

## Syncing with Code

The code lives in:
- `/Users/ja/sendmo/frontend/` - React frontend
- `/Users/ja/sendmo/backend/` - Next.js backend

Keep `SPEC.md` sections 3-4 (MVP Scope, User Flows) aligned with implementation.
