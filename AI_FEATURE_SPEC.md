# AI Item Recognition Feature

## Overview

Allow users to describe an item (text) or upload a photo, and AI will automatically estimate package dimensions, weight, and suggest the best shipping method.

## User Flows

### Flow 1: Text Description
```
User types: "iPhone 14 Pro in original box"
  ↓
AI analyzes description
  ↓
Returns:
- Category: Electronics > Mobile Phone
- Estimated dimensions: 6.5" × 3.5" × 2" (iPhone box)
- Estimated weight: 12 oz
- Suggested package size: Small Box
- Fragility: High (electronics)
- Recommended carrier: USPS Priority (signature required)
```

### Flow 2: Photo Upload
```
User uploads photo of backpack
  ↓
AI vision model analyzes image
  ↓
Returns:
- Category: Accessories > Backpack
- Estimated dimensions: 18" × 12" × 6"
- Estimated weight: 24 oz (1.5 lbs)
- Suggested package size: Medium Box
- Fragility: Low
- Recommended carrier: USPS Ground Advantage
```

### Flow 3: Combined (Text + Photo)
```
User types: "Vintage Nikon F3 camera with lens"
User uploads: Photo of the camera
  ↓
AI combines text context + visual analysis
  ↓
Returns more accurate estimate
```

## API Specification

### Endpoint
```
POST /api/ai/analyze-item
```

### Request
```typescript
{
  description?: string;           // Optional text description
  imageUrl?: string;             // Optional photo (uploaded to S3 first)
  imageBase64?: string;          // Or inline base64
  userHints?: {
    approximateWeight?: number;  // User's guess in oz
    approximateSize?: string;    // "small", "medium", etc.
  }
}
```

### Response
```typescript
{
  success: boolean;
  data: {
    // Item identification
    itemCategory: string;          // "Electronics > Mobile Phone"
    itemName: string;              // "iPhone 14 Pro"
    confidence: number;            // 0-1 confidence score
    
    // Physical properties
    estimatedDimensions: {
      length: number;              // inches
      width: number;
      height: number;
      unit: "in";
    };
    estimatedWeightOz: number;
    
    // Packaging recommendations
    suggestedPackageSize: "envelope" | "small" | "medium" | "large";
    suggestedPadding: "none" | "light" | "medium" | "heavy";
    
    // Shipping recommendations
    fragile: boolean;
    fragileReason?: string;        // "Glass lens, electronic components"
    requiresSignature: boolean;
    insuranceRecommended: boolean;
    insuranceValueCents?: number;
    
    // Carrier recommendations
    recommendedCarriers: Array<{
      carrier: string;
      service: string;
      reason: string;              // "Best for electronics - signature on delivery"
    }>;
    
    // Alternative interpretations
    alternativeInterpretations?: Array<{
      itemName: string;
      confidence: number;
      dimensions: { length: number; width: number; height: number };
    }>;
    
    // Warnings
    warnings?: string[];           // ["Item may require special handling", "Lithium battery restrictions apply"]
  };
  error?: {
    code: string;
    message: string;
  };
}
```

## AI Model Options

### Option 1: OpenAI GPT-4 Vision
**Pros:**
- Excellent object recognition
- Good at inferring size from context
- Can handle both text and images
- Easy to integrate

**Cons:**
- Expensive (~$0.01 per image)
- No fine-tuning on shipping-specific data
- API dependency

**Cost:** ~$0.01 per analysis

### Option 2: Custom Fine-tuned Model
**Pros:**
- Optimized for shipping/packaging
- Lower per-request cost at scale
- Can train on our own data

**Cons:**
- Upfront development cost
- Requires training data
- Maintenance overhead

**Cost:** High upfront, ~$0.001 per analysis at scale

### Option 3: Hybrid Approach (Recommended for MVP)
**Pros:**
- Use GPT-4 Vision for complex items
- Use simple rules for common items
- Best cost/accuracy tradeoff

**Implementation:**
```typescript
async function analyzeItem(description: string, imageUrl?: string) {
  // Step 1: Check against common item database
  const commonItem = await checkCommonItems(description);
  if (commonItem && commonItem.confidence > 0.9) {
    return commonItem; // Fast path for "iPhone 14", "MacBook", etc.
  }
  
  // Step 2: Use AI for complex items
  return await callGPT4Vision(description, imageUrl);
}
```

## Common Items Database

Pre-load dimensions for frequently shipped items:

```typescript
const COMMON_ITEMS = {
  "iphone 14": {
    dimensions: { length: 6.5, width: 3.5, height: 2 },
    weightOz: 12,
    category: "Electronics > Mobile Phone",
    fragile: true,
    requiresSignature: true
  },
  "macbook pro 14": {
    dimensions: { length: 14, width: 10, height: 2 },
    weightOz: 64,
    category: "Electronics > Laptop",
    fragile: true,
    requiresSignature: true
  },
  "t-shirt": {
    dimensions: { length: 12, width: 8, height: 1 },
    weightOz: 6,
    category: "Clothing > Shirt",
    fragile: false,
    requiresSignature: false
  },
  // ... add top 100 commonly shipped items
};
```

## GPT-4 Vision Prompt

```typescript
const ANALYSIS_PROMPT = `You are an expert at estimating package dimensions and shipping requirements.

Analyze this item and provide:
1. Item category (be specific: "Electronics > Mobile Phone", not just "Electronics")
2. Estimated physical dimensions in inches (length × width × height)
3. Estimated weight in ounces
4. Whether it's fragile
5. Any shipping restrictions or special requirements

Item description: {description}
{image attached}

Respond in JSON format:
{
  "itemCategory": "...",
  "itemName": "...",
  "estimatedDimensions": { "length": 0, "width": 0, "height": 0 },
  "estimatedWeightOz": 0,
  "fragile": true/false,
  "fragileReason": "...",
  "requiresSignature": true/false,
  "warnings": ["..."],
  "confidence": 0.0-1.0
}

Be conservative with dimensions (slightly overestimate to ensure safe shipping).
Consider that items are usually shipped in their retail boxes if mentioned.`;
```

## UI Integration

### Where AI Suggestions Appear

**1. During Label Creation (Receiver Side)**
```
┌─────────────────────────────────────┐
│ What are you receiving?             │
│ ┌─────────────────────────────────┐ │
│ │ Vintage Nikon camera            │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [📷 Add Photo] (optional)           │
│                                     │
│ ✨ AI Suggestions:                  │
│ ┌─────────────────────────────────┐ │
│ │ 📦 Medium Box (12×9×6)          │ │
│ │ ⚖️  ~2 lbs                       │ │
│ │ 🔒 Signature recommended        │ │
│ │ 💰 Insurance: $200-300          │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [Use These Settings] [Customize]    │
└─────────────────────────────────────┘
```

**2. Smart Defaults**
- Pre-fill package size dropdown
- Pre-select appropriate carrier
- Auto-enable signature if valuable
- Suggest insurance amount

**3. Confidence Indicators**
```
High confidence (>0.8): ✅ "We're confident about these estimates"
Medium confidence (0.5-0.8): ⚠️ "Please verify these estimates"
Low confidence (<0.5): ❌ "Please enter details manually"
```

## Error Handling

### Ambiguous Items
```
User: "shoes"

AI Response:
{
  confidence: 0.4,
  warnings: ["Item description is too vague"],
  suggestions: [
    "What type of shoes? (sneakers, boots, heels)",
    "In a shoe box or loose?",
    "Adult or children's size?"
  ]
}
```

### Restricted Items
```
User: "lithium batteries"

AI Response:
{
  warnings: [
    "⚠️ Lithium batteries have shipping restrictions",
    "Cannot ship via air (USPS Priority Mail Express not available)",
    "Must use USPS Ground only",
    "Requires special labeling"
  ],
  recommendedCarriers: [
    { carrier: "USPS", service: "Parcel Select Ground" }
  ]
}
```

## Cost Analysis

### Per-Request Costs
- GPT-4 Vision: $0.01 per image
- Text-only GPT-4: $0.001 per request
- Common item lookup: $0 (cached)

### Monthly Costs (at scale)
- 10,000 labels/month
- 30% use AI feature
- 50% are common items (cached)
- 50% need GPT-4 Vision

**Cost:** 3,000 × 50% × $0.001 + 3,000 × 50% × $0.01 = $1.50 + $15 = **$16.50/month**

Very affordable!

## Future Enhancements

### Phase 2: Learning from Actual Shipments
```
User estimates: Medium box, 2 lbs
Sender confirms: Large box, 3.5 lbs
  ↓
Feed back into training data
  ↓
Improve future estimates for similar items
```

### Phase 3: Computer Vision for Dimensions
```
User uploads photo with reference object (credit card, ruler)
  ↓
AI measures actual dimensions from photo
  ↓
More accurate estimates
```

### Phase 4: Marketplace-Specific Models
```
eBay listings → trained model for used items
Poshmark → trained model for clothing
Facebook Marketplace → trained model for furniture/large items
```

## Implementation Checklist

- [ ] Set up OpenAI API integration
- [ ] Build common items database (top 100)
- [ ] Create analysis endpoint
- [ ] Add photo upload to S3
- [ ] Build UI for AI suggestions
- [ ] Add confidence indicators
- [ ] Handle edge cases (ambiguous, restricted)
- [ ] Track accuracy metrics
- [ ] A/B test with/without AI feature
- [ ] Optimize costs (cache common items)

## Success Metrics

- **Adoption rate:** % of users who use AI suggestions
- **Acceptance rate:** % who accept AI suggestions vs customize
- **Accuracy:** How often AI estimates match actual dimensions
- **Time saved:** Average time to complete label (with vs without AI)
- **Cost per successful estimate:** Total AI costs / labels created

**Target:** 50% adoption, 80% acceptance, <5% dimensional errors
