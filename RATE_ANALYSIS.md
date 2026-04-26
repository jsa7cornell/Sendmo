# SendMo Rate Analysis — Competitive Pricing & Margin Study

> **Date of analysis:** 2026-03-19
> **Analyst:** Claude (claude-sonnet-4-6) on behalf of John Abramson
> **Purpose:** Assess whether EasyPost rates are competitive, whether SendMo prices are competitive with alternatives, and what margin structure looks like across shipment types.

---

## 1. Executive Summary

**SendMo's carrier rates are competitive.** EasyPost provides USPS Merchant Discount Pricing — the same sub-commercial discount tier that Pirate Ship accesses via USPS Connect eCommerce. Both sit in the deepest publicly-available USPS rate tier, meaning SendMo's wholesale cost for USPS services is roughly on par with the lowest-cost competitors (estimated 40–48% below retail for Priority Mail, 38–42% below retail for Ground Advantage).

**SendMo's retail prices are not the cheapest available.** Pirate Ship charges customers essentially the EasyPost wholesale rate (no markup, zero-fee model). SendMo's 15% markup means customers consistently pay ~15% more than Pirate Ship for an identical label. On a typical Ground Advantage shipment, this is $0.50–$1.00 more. On Priority Mail cross-country, it's $1.50–$2.00 more.

**This is a business model decision, not a rate problem.** Pirate Ship earns carrier rebates with no user-visible markup. SendMo earns its margin through the markup. The 15% is the cost of the platform's unique value prop — the recipient-pays, link-based model. The question isn't "can we get better rates?" but "does our product differentiation justify the premium?"

**Margin is thin but sustainable for the MVP phase.** Dollar margins range from ~$0.50 on cheap local shipments to ~$2.00+ on cross-country Priority Mail. Percentage margin is a consistent 15% on EasyPost cost (13% of display price). This is insufficient for high-cost operations at scale, but fine for the current phase.

---

## 2. Our Pricing Model

```
DisplayPrice = EasyPostRate × 1.15   (standard, credit card)
DisplayPrice = EasyPostRate × 1.10   (SendMo Balance — planned)
```

**Markup:** 15% over EasyPost wholesale cost
**Gross margin on display price:** 15/115 = **13.0%**

**Source:** `supabase/functions/rates/index.ts` line 5 (`MARKUP_MULTIPLIER = 1.15`)

---

## 3. USPS Rate Tier Hierarchy

Understanding *which rate tier* everyone sits in is critical context for this analysis.

| Tier | Who Accesses It | Approximate Discount vs. Retail |
|------|-----------------|--------------------------------|
| **Retail** | Post office counter, usps.com | Baseline (0%) |
| **USPS Commercial** | Shippo, stamps.com (basic tier) | ~15–20% below retail |
| **Below Commercial (sub-comm)** | Pirate Ship (Connect eCommerce), EasyPost (Merchant Discount), stamps.com (discounted tiers) | ~35–55% below retail |

**Key finding:** EasyPost and Pirate Ship are in the same tier — both access sub-commercial USPS rates through separate USPS partner programs. Neither publishes exact rates (USPS prohibits disclosure). SendMo's wholesale cost is therefore approximately competitive with Pirate Ship's cost.

---

## 4. Rate Comparison Tables

### Methodology & Data Quality

| Data Type | Source | Confidence |
|-----------|--------|------------|
| USPS Retail Rates (July 2025) | Pitney Bowes rate tables, USPS Postal Explorer Notice 123 | **High — authoritative** |
| January 2026 Retail Rates | +6.6% PM / +7.8% GA adjustment per USPS GRI | **Medium-High — estimated** |
| EasyPost Merchant Discount | Estimated 43% off retail (PM) / 40% off retail (GA); EasyPost claims "up to 48% off" | **Medium — estimated range** |
| SendMo Display Price | Calculated from EasyPost estimate × 1.15 | **Medium — derived from estimate** |
| Pirate Ship Rate | ~Same as EasyPost base (same tier); one third-party estimate found | **Medium — estimated** |
| UPS Ground Retail | Quadient UPS rate table (Dec 2025) | **High — authoritative** |
| Stamps.com | "Up to 52% off retail" for Priority Mail; monthly subscription req'd | **Medium — marketing range** |

> **Important:** EasyPost and Pirate Ship rates cannot be verified without an active account + live rate fetch. All sub-commercial estimates below are derived from stated discount ranges, not API calls. Actual EasyPost rates may be better or worse depending on SendMo's specific contract tier.

---

### Zone Reference: From San Francisco 94107

| Destination | Distance | Zone |
|-------------|----------|------|
| Sacramento, CA | ~90 mi | Zone 2 |
| Los Angeles, CA | ~380 mi | Zone 4 |
| Denver, CO | ~1,250 mi | Zone 6 |
| New York, NY | ~2,900 mi | Zone 8 |

---

### 4a. USPS Ground Advantage — Retail vs. SendMo vs. Competitors

*Economy/ground service; 3–5 business days domestic*

| Package | Route | Zone | USPS Retail* | EasyPost Est. | SendMo Est. | Pirate Ship Est. | SendMo Margin |
|---------|-------|------|-------------|--------------|-------------|-----------------|---------------|
| 1 lb, 8x6x4" | SF→Sacramento | Z2 | ~$5.50 | ~$3.25 | **~$3.74** | ~$3.25 | ~$0.49 (13%) |
| 1 lb, 8x6x4" | SF→Los Angeles | Z4 | ~$6.86 | ~$4.12 | **~$4.74** | ~$4.12 | ~$0.62 (13%) |
| 1 lb, 8x6x4" | SF→Denver | Z6 | ~$8.00 | ~$4.80 | **~$5.52** | ~$4.80 | ~$0.72 (13%) |
| 1 lb, 8x6x4" | SF→New York | Z8 | ~$9.39 | ~$5.63 | **~$6.47** | ~$5.63 | ~$0.84 (13%) |
| 3 lbs, 12x10x6" | SF→Los Angeles | Z4 | ~$7.72 | ~$4.63 | **~$5.32** | ~$4.63 | ~$0.69 (13%) |
| 3 lbs, 12x10x6" | SF→New York | Z8 | ~$12.63 | ~$7.58 | **~$8.72** | ~$7.58 | ~$1.14 (13%) |
| 10 lbs, 18x14x10" | SF→Los Angeles | Z4 | ~$14.50† | ~$8.70† | **~$10.01†** | ~$8.70† | ~$1.30 (13%) |
| 10 lbs, 18x14x10" | SF→New York | Z8 | ~$23.00† | ~$13.80† | **~$15.87†** | ~$13.80† | ~$2.07 (13%) |

*January 2026 estimated retail (July 2025 rates +7.8%)
† 10 lb estimates extrapolated — verify with live rate fetch before relying on these

---

### 4b. USPS Priority Mail — Retail vs. SendMo vs. Competitors

*2–3 day service*

| Package | Route | Zone | USPS Retail* | EasyPost Est. | SendMo Est. | Pirate Ship Est. | SendMo Margin |
|---------|-------|------|-------------|--------------|-------------|-----------------|---------------|
| 1 lb, 8x6x4" | SF→Sacramento | Z2 | ~$9.20 | ~$5.24 | **~$6.03** | ~$5.24 | ~$0.79 (13%) |
| 1 lb, 8x6x4" | SF→Los Angeles | Z4 | ~$11.71 | ~$6.67 | **~$7.67** | ~$6.67 | ~$1.00 (13%) |
| 1 lb, 8x6x4" | SF→Denver | Z6 | ~$15.00 | ~$8.55 | **~$9.83** | ~$8.55 | ~$1.28 (13%) |
| 1 lb, 8x6x4" | SF→New York | Z8 | ~$19.28 | ~$10.99 | **~$12.64** | ~$10.85* | ~$1.65 (13%) |
| 3 lbs, 12x10x6" | SF→Los Angeles | Z4 | ~$13.04 | ~$7.43 | **~$8.55** | ~$7.43 | ~$1.12 (13%) |
| 3 lbs, 12x10x6" | SF→New York | Z8 | ~$21.80 | ~$12.43 | **~$14.29** | ~$12.43 | ~$1.86 (13%) |
| 10 lbs, 18x14x10" | SF→Los Angeles | Z4 | ~$28.00† | ~$15.96† | **~$18.35†** | ~$15.96† | ~$2.39 (13%) |
| 10 lbs, 18x14x10" | SF→New York | Z8 | ~$45.00† | ~$25.65† | **~$29.50†** | ~$25.65† | ~$3.85 (13%) |

*January 2026 estimated retail (+6.6%). †Extrapolated — verify with live rate fetch.
*Pirate Ship 1 lb Z8 PM estimate from one third-party source; aligns closely with EasyPost estimate.

---

### 4c. USPS Priority Mail Express — Retail vs. SendMo

*Overnight/1–2 day service*

| Package | Route | Zone | USPS Retail* | EasyPost Est. | SendMo Est. | Pirate Ship Est. | SendMo Margin |
|---------|-------|------|-------------|--------------|-------------|-----------------|---------------|
| 1 lb, 8x6x4" | SF→Los Angeles | Z4 | ~$40.66 | ~$24.40 | **~$28.06** | ~$24.40 | ~$3.66 (13%) |
| 1 lb, 8x6x4" | SF→New York | Z8 | ~$58.74 | ~$35.24 | **~$40.53** | ~$35.24 | ~$5.29 (13%) |

*January 2026 estimated retail (+13.7% over July 2025 $35.80/$51.65). Express GRI varies.

---

### 4d. UPS Ground — Retail vs. EasyPost Sub-Commercial

*4–7 day ground; residential surcharge ~$5.40 additional at retail*

| Package | Route | UPS Retail (Dec 2025) | EasyPost UPS Est. | SendMo Est. | SendMo Margin |
|---------|-------|-----------------------|-------------------|-------------|---------------|
| 1 lb, 8x6x4" | SF→Los Angeles | $13.51 | ~$5.00–7.00† | ~$5.75–8.05† | ~$0.75–1.05 |
| 1 lb, 8x6x4" | SF→New York | $15.03 | ~$5.50–8.00† | ~$6.33–9.20† | ~$0.83–1.20 |
| 3 lbs, 12x10x6" | SF→Los Angeles | $16.08 | ~$6.50–9.00† | ~$7.48–10.35† | ~$0.98–1.35 |
| 3 lbs, 12x10x6" | SF→New York | $19.14 | ~$7.50–11.00† | ~$8.63–12.65† | ~$1.13–1.65 |

†UPS rates via EasyPost are highly variable. Pirate Ship claims "up to 81% off UPS Daily Rates" — exact EasyPost UPS rates require a live API call. The retail discount is typically 50–70% for well-negotiated partnerships.

**Note:** UPS retail includes a residential surcharge ($5.40 in 2025) not shown here. Including it, UPS retail for residential delivery would be $18.91–$24.54 for the above scenarios. EasyPost sub-commercial UPS rates often beat USPS Priority Mail for packages under 2 lbs to closer zones.

---

### 4e. Heavy/Oversized Box (25 lbs, 24x18x12")

At 25 lbs, USPS Priority Mail becomes significantly more expensive than UPS/FedEx Ground for most zones:

| Service | Route | Retail Est. | EasyPost Est. | SendMo Est. |
|---------|-------|-------------|--------------|-------------|
| USPS Priority Mail | SF→NY | ~$95–110† | ~$55–65† | ~$63–75† |
| UPS Ground | SF→NY | ~$45–55† | ~$20–35† | ~$23–40† |
| USPS Ground Advantage | SF→NY | ~$55–65† | ~$35–45† | ~$40–52† |

†Heavy box rates are highly package-dimension dependent (dimensional weight pricing applies). These are rough estimates only — not suitable for quoting. A live rate fetch is essential for this weight class.

**At 25 lbs: UPS Ground via EasyPost is likely the cheapest carrier available, and SendMo's display price should still undercut UPS retail by 40–50%.**

---

## 5. Margin Analysis

### What We Earn Per Shipment

| Scenario | EasyPost Cost Est. | SendMo Display | Dollar Margin | % of Display |
|----------|-------------------|----------------|---------------|--------------|
| Ground Advantage, 1 lb, short hop | ~$3.25 | ~$3.74 | **$0.49** | 13.0% |
| Ground Advantage, 1 lb, cross-country | ~$5.63 | ~$6.47 | **$0.84** | 13.0% |
| Ground Advantage, 3 lbs, cross-country | ~$7.58 | ~$8.72 | **$1.14** | 13.0% |
| Priority Mail, 1 lb, regional (Z6) | ~$8.55 | ~$9.83 | **$1.28** | 13.0% |
| Priority Mail, 1 lb, cross-country | ~$10.99 | ~$12.64 | **$1.65** | 13.0% |
| Priority Mail, 3 lbs, cross-country | ~$12.43 | ~$14.29 | **$1.86** | 13.0% |
| Priority Mail Express, 1 lb, cross-country | ~$35.24 | ~$40.53 | **$5.29** | 13.0% |

**Margin is uniformly 13% of the display price (or 15% above cost).** This is because the markup multiplier is fixed at 1.15 with no dynamic pricing.

### Margin Sustainability Assessment

**MVP phase (current):** 13% gross margin is thin but workable if volume costs (infrastructure, support) stay low. At $1–2/label average margin, you'd need 1,000 labels/month to generate $1,000–$2,000 in gross profit.

**At scale:** 13% gross margin leaves very little room after Stripe fees (~2.9% + $0.30), Supabase, hosting, customer support, etc. A $7 Ground Advantage label at $0.84 margin yields roughly $0.40–0.50 after payment processing.

**Where margin is best:** High-value, time-sensitive shipments (Priority Mail, Priority Mail Express) generate higher absolute dollar margins while percentage stays flat.

**Where margin is thinnest in dollar terms:** Very cheap local Ground Advantage shipments ($0.49/label). These are barely worth the payment processing overhead until payment fees are optimized.

---

## 6. Competitive Position

### SendMo vs. Pirate Ship

Pirate Ship is the closest competitor model (consumer-facing discounted shipping labels). Key comparison:

| Dimension | SendMo | Pirate Ship |
|-----------|--------|-------------|
| Price to customer | EasyPost wholesale × 1.15 | Essentially carrier wholesale (no markup) |
| Business model | Markup-based | Carrier rebate |
| Account required? | No (recipient creates link) | Yes (account + login) |
| Who initiates? | Recipient creates link, sender ships | Sender goes to Pirate Ship directly |
| Batch shipping | No | Yes |
| Multi-carrier quotes | Yes (EasyPost) | Yes (USPS + UPS) |
| Insurance | Not yet | Yes ($1/100 declared value) |
| International | Not yet | Yes |
| Monthly fee | None | None |
| Rate tier | USPS Merchant Discount (sub-commercial) | USPS Connect eCommerce (sub-commercial) |

**The 15% price gap:** Pirate Ship charges customers roughly 15% less than SendMo for an identical USPS shipment. On a $10 Priority Mail label, that's $1.50 more for SendMo. For price-sensitive shippers, this matters.

**But:** Pirate Ship doesn't offer SendMo's core value prop. Pirate Ship requires the *sender* to have an account and know the recipient's address. SendMo allows the *recipient* to create a link and give it to the sender — the sender never needs an account, never stores the address, never navigates a shipping app. This is a genuinely different use case.

### SendMo vs. Shippo

Shippo is a developer/business platform, not consumer-focused. Free tier + subscription, with per-label fee on Starter. More direct SendMo competitor if B2B pivot occurs. Less relevant for the current consumer use case.

### SendMo vs. Stamps.com

Stamps.com requires a monthly subscription ($20.99–$39.99/month). For occasional shippers, Stamps.com is more expensive total cost despite accessing similar rate tiers. SendMo (and Pirate Ship) win on no-subscription convenience.

### Savings vs. Retail (SendMo's actual marketing claim headroom)

Based on our estimates:
- Ground Advantage: SendMo saves customer **30–35% vs. USPS retail** (Pirate Ship saves 40–45%)
- Priority Mail: SendMo saves customer **33–37% vs. USPS retail** (Pirate Ship saves ~43%)
- UPS Ground: SendMo likely saves customer **55–70% vs. UPS retail** (huge gap due to UPS retail being inflated)

**Honest marketing claim: "Save up to 35% off USPS retail shipping rates"** — this is defensible and true for most scenarios. "Save up to 70% off UPS retail" is also defensible for UPS comparisons.

---

## 7. Recommendations

### Rate Sourcing
1. **No action needed on EasyPost rates for MVP.** EasyPost Merchant Discount is the right tier — competitive with Pirate Ship's wholesale cost. As volume grows, negotiate better rates directly with EasyPost or explore direct USPS Connect eCommerce enrollment.
2. **Consider a live rate test.** Pull actual live EasyPost rates for a 1 lb SF→NY Priority Mail shipment and compare to the estimates in this document. This would validate (or correct) all the estimates above.

### Markup & Pricing Strategy
3. **The 15% markup is appropriate for now.** Don't lower it before Stripe fees + ops costs are understood. The realistic net margin after Stripe's 2.9% + $0.30 is closer to 9–10% of display price.
4. **Consider volume-based discounts at scale.** When volume reaches 500+ labels/month, a loyalty reward (SendMo Balance with 10% markup) becomes more impactful. This is already planned.
5. **Do not compete on price with Pirate Ship.** You can't win — their zero-markup model is structurally lower. Instead, emphasize the link model's unique convenience and privacy.

### Marketing Positioning
6. **Lead with "Save 30%+ off retail USPS rates" in marketing.** This is true, verifiable, and meaningful to the average consumer who compares to USPS.com.
7. **Don't claim "cheapest rates" — you can't.** Pirate Ship specifically targets that claim. Acknowledge the tradeoff: SendMo = convenience + privacy + recipient-pays model at a small premium.
8. **UPS is your strongest price comparison story.** UPS retail is wildly expensive. Saying "up to 70% off UPS retail" is eye-catching and honest.

### Product Recommendations
9. **Add insurance UI.** Pirate Ship offers insurance and it adds per-label margin. At $1–2/package for $100 coverage, it's a natural upsell.
10. **Avoid heavy/oversized until the model is proven.** 25 lb+ packages involve dimensional weight, carrier surcharges, and complex pricing. The margin isn't better and the complexity is high.
11. **Priority Mail is the sweet spot.** Best margin per label ($1.50–$2.00+) with a meaningful discount vs. retail. Ground Advantage has thin absolute margin but high volume potential.

### Operational Watch Items
12. **Payment processing cost erodes margin on cheap labels.** A $3.74 Ground Advantage label charged via Stripe generates ~$0.11 in processing fees (2.9% + $0.30 = $0.41), which exceeds the $0.49 label margin. Consider minimum order size or batch charging when Stripe is live.
13. **Monitor EasyPost rate changes.** USPS adjusts rates twice/year. After each adjustment, re-verify that our EasyPost cost hasn't risen faster than the retail rate (which would compress margin without us knowing).

---

## 8. Data Sources & Methodology

| Source | Data Used |
|--------|-----------|
| Pitney Bowes USPS 2025 Rate Tables | July 2025 retail rates for Priority Mail, Ground Advantage |
| USPS Postal Explorer Notice 123 (July 2025) | Authoritative rate table confirmation |
| Quadient UPS Rate Tables (Dec 2025) | UPS Ground retail rates |
| EasyPost pricing page + blog (Merchant Discount announcement, 2023) | Rate tier position, "up to 48% off retail" claim |
| Pirate Ship rates page + USPS Commercial Pricing page | Rate tier position, savings claims |
| Pirate Ship 2026 rate changes support article | Confirmation of ~43% off retail for Priority Mail |
| Shippo pricing page | Plan tiers and per-label fee structure |
| Stamps.com pricing + rate discounts pages | Subscription fees, discount percentage claims |
| SendMo codebase (`supabase/functions/rates/index.ts`) | Markup multiplier (1.15), pricing logic |

**January 2026 rate adjustment factors applied:** USPS raised rates on January 19, 2026. Adjustment applied: Priority Mail +6.6%, Ground Advantage +7.8%, Priority Mail Express ~+13.7% (based on Pirate Ship 2026 rate article and USPS historical GRI patterns).

**Estimates vs. actuals:** Approximately 60% of the data in this document is derived from stated discount ranges, not live API calls. To get precise numbers, run a live EasyPost rate fetch for the key scenarios and compare against USPS.com retail calculator. Recommend doing this before any investor/press conversations about pricing.

---

## 9. Summary Table: Key Rate Benchmarks (January 2026 estimates)

| Service + Scenario | USPS Retail | EasyPost (our cost) | SendMo (display) | Pirate Ship (approx) | Our discount vs retail | Gap vs Pirate Ship |
|---|---|---|---|---|---|---|
| Ground Advantage, 1 lb, SF→NY | ~$9.39 | ~$5.63 | ~$6.47 | ~$5.63 | **31%** | +$0.84 |
| Ground Advantage, 3 lbs, SF→NY | ~$12.63 | ~$7.58 | ~$8.72 | ~$7.58 | **31%** | +$1.14 |
| Priority Mail, 1 lb, SF→LA | ~$11.71 | ~$6.67 | ~$7.67 | ~$6.67 | **35%** | +$1.00 |
| Priority Mail, 1 lb, SF→NY | ~$19.28 | ~$10.99 | ~$12.64 | ~$10.85 | **34%** | +$1.79 |
| Priority Mail, 3 lbs, SF→NY | ~$21.80 | ~$12.43 | ~$14.29 | ~$12.43 | **34%** | +$1.86 |
| Priority Mail Express, 1 lb, SF→NY | ~$58.74 | ~$35.24 | ~$40.53 | ~$35.24 | **31%** | +$5.29 |
| UPS Ground, 1 lb, SF→NY | ~$20.43 (w/ resid.) | ~$6.00–9.00 | ~$6.90–10.35 | ~$6.00–9.00 | **52–66%** | +~15% |

---

*Document generated 2026-03-19. Rates are estimates — verify against live EasyPost API before making pricing decisions or public claims. USPS adjusts rates ~January and ~July each year; refresh this analysis after each rate change.*
