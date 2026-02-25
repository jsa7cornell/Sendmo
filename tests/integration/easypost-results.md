# EasyPost Integration Test Report

**Generated:** 2026-02-25T00:52:08.815Z  
**Total Duration:** 447.1s  
**Mode:** Rates + Labels  
**Edge Functions Base:** `https://fkxykvzsqdjzhurntgah.supabase.co`  

## Summary

| Metric | Value |
|--------|-------|
| Address Pairs Tested | 205 |
| Rate Requests Succeeded | ✅ 205 / 205 |
| Rate Requests Failed (unexpected) | 0 |
| Rate Requests Failed (expected bad addr) | 0 |
| Total Individual Rates Returned | 3356 |
| Avg Rates Per Successful Pair | 16.4 |
| Unique Carriers | 3 (FedExDefault, UPSDAP, USPS) |
| Unique Services | 19 |
| Avg Rate Request Duration | 2052ms |
| Labels Purchased | ✅ 192 / 201 |
| Label Failures | ❌ 9 |
| Avg Label Purchase Duration | 2455ms |

## Carrier & Service Breakdown

| Carrier | Service | Times Seen | Min Price | Max Price | Avg Price | Avg Days |
|---------|---------|-----------|-----------|-----------|-----------|----------|
| FedExDefault | FEDEX_2_DAY | 200 | $19.39 | $109.38 | $42.51 | 2.0 |
| FedExDefault | FEDEX_2_DAY_AM | 200 | $41.95 | $187.36 | $75.02 | 2.0 |
| FedExDefault | FEDEX_EXPRESS_SAVER | 200 | $16.45 | $90.01 | $33.56 | 5.0 |
| FedExDefault | FEDEX_GROUND | 200 | $16.79 | $65.75 | $28.51 | 2.9 |
| FedExDefault | FIRST_OVERNIGHT | 65 | $105.85 | $196.56 | $169.45 | 1.0 |
| FedExDefault | PRIORITY_OVERNIGHT | 200 | $37.08 | $140.91 | $73.99 | 1.0 |
| FedExDefault | SMART_POST | 201 | $8.06 | $42.69 | $16.39 | 3.9 |
| FedExDefault | STANDARD_OVERNIGHT | 200 | $32.65 | $132.30 | $68.28 | 1.0 |
| UPSDAP | 2ndDayAir | 200 | $11.18 | $90.51 | $35.47 | 2.0 |
| UPSDAP | 2ndDayAirAM | 200 | $12.85 | $105.44 | $41.57 | 2.0 |
| UPSDAP | 3DaySelect | 200 | $10.74 | $64.20 | $23.31 | 3.0 |
| UPSDAP | Ground | 200 | $7.20 | $40.76 | $16.01 | 2.8 |
| UPSDAP | NextDayAir | 200 | $22.85 | $151.24 | $80.24 | 1.0 |
| UPSDAP | NextDayAirEarlyAM | 200 | $59.39 | $187.76 | $116.77 | 1.0 |
| UPSDAP | NextDayAirSaver | 200 | $16.71 | $143.27 | $72.51 | 1.0 |
| UPSDAP | UPSGroundsaverGreaterThan1lb | 133 | $6.62 | $60.94 | $29.13 | 4.8 |
| USPS | Express | 97 | $33.12 | $180.55 | $55.15 | 1.5 |
| USPS | GroundAdvantage | 130 | $5.58 | $77.12 | $23.45 | 3.4 |
| USPS | Priority | 130 | $8.79 | $130.47 | $38.83 | 2.4 |

## Results by Parcel Size

### Small Envelope (12×9×1in, 4oz)
- Pairs tested: 72
- Rates succeeded: 72
- Rates failed: 0
- Price range: $5.58 – $196.56

### Medium Box (12×10×8in, 32oz)
- Pairs tested: 67
- Rates succeeded: 67
- Rates failed: 0
- Price range: $6.62 – $150.72

### Large Heavy Box (20×15×12in, 160oz)
- Pairs tested: 66
- Rates succeeded: 66
- Rates failed: 0
- Price range: $17.48 – $187.76

## Label Purchase Results

### ❌ Label Failures

| Route | Carrier | Service | Price | Error | Duration |
|-------|---------|---------|-------|-------|----------|
| Chicago,IL → Baltimore,MD | FedExDefault | SMART_POST | $21.91 | {"transactionId":"1b95dcd3-be99-4420-9f19-9951ae8ffbc7","errors":[{"code":"SYSTEM.UNEXPECTED.ERROR","message":"The system has experienced an unexpected problem and is unable to complete your request.  Please try again later.  We regret any inconvenience."}]} | 1625ms |
| Phoenix,AZ → Austin,TX | FedExDefault | SMART_POST | $25.81 | {"transactionId":"be960ad2-e94d-4728-a23c-7bffac8ebf49","errors":[{"code":"SYSTEM.UNEXPECTED.ERROR","message":"The system has experienced an unexpected problem and is unable to complete your request.  Please try again later.  We regret any inconvenience."}]} | 1004ms |
| Phoenix,AZ → Fort Worth,TX | FedExDefault | SMART_POST | $25.81 | Unable to complete shipment purchase: carrier timed out responding to our request. Please try again or contact support | 7770ms |
| Philadelphia,PA → Indianapolis,IN | FedExDefault | SMART_POST | $8.06 | Unable to complete shipment purchase: carrier timed out responding to our request. Please try again or contact support | 7792ms |
| Philadelphia,PA → Fort Worth,TX | FedExDefault | SMART_POST | $8.77 | Unable to complete shipment purchase: carrier timed out responding to our request. Please try again or contact support | 7741ms |
| Philadelphia,PA → Milwaukee,WI | FedExDefault | SMART_POST | $8.36 | Unable to complete shipment purchase: carrier timed out responding to our request. Please try again or contact support | 7735ms |
| San Antonio,TX → Jacksonville,FL | FedExDefault | SMART_POST | $25.81 | Unable to complete shipment purchase: carrier timed out responding to our request. Please try again or contact support | 7769ms |
| San Antonio,TX → San Jose,CA | FedExDefault | SMART_POST | $8.77 | Unable to complete shipment purchase: carrier timed out responding to our request. Please try again or contact support | 7933ms |
| San Diego,CA → Indianapolis,IN | FedExDefault | SMART_POST | $8.77 | {"transactionId":"1102a6f2-22ee-40f7-ab95-fba903301f86","errors":[{"code":"SYSTEM.UNEXPECTED.ERROR","message":"The system has experienced an unexpected problem and is unable to complete your request.  Please try again later.  We regret any inconvenience."}]} | 1465ms |

### ✅ Label Successes by Service

| Carrier | Service | Labels Created |
|---------|---------|---------------|
| FedExDefault | SMART_POST | 16 |
| UPSDAP | Ground | 63 |
| UPSDAP | UPSGroundsaverGreaterThan1lb | 65 |
| USPS | GroundAdvantage | 48 |

### Sample Labels (first 10)

| Route | Carrier | Service | Tracking | Label URL |
|-------|---------|---------|----------|-----------|
| San Francisco,CA → Austin,TX | USPS | GroundAdvantage | `9400100208303111718083` | [View](https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260225/e8d5a0b05424d1499b94f71745d3f49fba.png) |
| San Francisco,CA → Charlotte,NC | UPSDAP | UPSGroundsaverGreaterThan1lb | `1ZXXXXXXXXXXXXXXXX` | [View](https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260225/e8ec23fb0759ba4028bb78ca6f4d19c4c0.png) |
| San Francisco,CA → Columbus,OH | UPSDAP | Ground | `1ZXXXXXXXXXXXXXXXX` | [View](https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260225/e8cfd79575df3e4aacabbcf6864015d5a3.png) |
| San Francisco,CA → Indianapolis,IN | USPS | GroundAdvantage | `9400100208303111718090` | [View](https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260225/e88e2583ead9ef475895400e794de7c779.png) |
| San Francisco,CA → Jacksonville,FL | UPSDAP | UPSGroundsaverGreaterThan1lb | `1ZXXXXXXXXXXXXXXXX` | [View](https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260225/e8b9a8d04d827d46ab936f58e567e93463.png) |
| San Francisco,CA → San Jose,CA | UPSDAP | Ground | `1ZXXXXXXXXXXXXXXXX` | [View](https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260225/e8b4524765bc0b484db596e369f3e844be.png) |
| San Francisco,CA → Fort Worth,TX | USPS | GroundAdvantage | `9400100208303111718106` | [View](https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260225/e89658ac8982aa4fad8b47671d497ae690.png) |
| San Francisco,CA → Memphis,TN | UPSDAP | UPSGroundsaverGreaterThan1lb | `1ZXXXXXXXXXXXXXXXX` | [View](https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260225/e8841417bb647b447794a9d007a237b15d.png) |
| San Francisco,CA → Baltimore,MD | UPSDAP | Ground | `1ZXXXXXXXXXXXXXXXX` | [View](https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260225/e81975a2331edd406d8197b154a4324fe0.png) |
| San Francisco,CA → Milwaukee,WI | USPS | GroundAdvantage | `9400100208303111718113` | [View](https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260225/e896dead8ca82a43deaca500a5847c2897.png) |

## Error Catalog

| Error | Occurrences |
|-------|-------------|
| Unable to complete shipment purchase: carrier timed out responding to our request. Please try again or contact support | 6 |
| {"transactionId":"1b95dcd3-be99-4420-9f19-9951ae8ffbc7","errors":[{"code":"SYSTEM.UNEXPECTED.ERROR","message":"The system has experienced an unexpected problem and is unable to complete your request.  Please try again later.  We regret any inconvenience."}]} | 1 |
| {"transactionId":"be960ad2-e94d-4728-a23c-7bffac8ebf49","errors":[{"code":"SYSTEM.UNEXPECTED.ERROR","message":"The system has experienced an unexpected problem and is unable to complete your request.  Please try again later.  We regret any inconvenience."}]} | 1 |
| {"transactionId":"1102a6f2-22ee-40f7-ab95-fba903301f86","errors":[{"code":"SYSTEM.UNEXPECTED.ERROR","message":"The system has experienced an unexpected problem and is unable to complete your request.  Please try again later.  We regret any inconvenience."}]} | 1 |

## Full Rate Results

<details><summary>Click to expand all 200+ rows</summary>

| # | Route | Parcel | OK? | Rates | Carriers | Cheapest | Time |
|---|-------|--------|-----|-------|----------|----------|------|
| 1 | San Francisco,CA → Austin,TX | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $6.08 | 2012ms |
| 2 | San Francisco,CA → Charlotte,NC | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 2206ms |
| 3 | San Francisco,CA → Columbus,OH | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $40.76 | 2233ms |
| 4 | San Francisco,CA → Indianapolis,IN | Small Envelope | ✅ | 17 | USPS, FedExDefault, UPSDAP | $6.35 | 1849ms |
| 5 | San Francisco,CA → Jacksonville,FL | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 1887ms |
| 6 | San Francisco,CA → San Jose,CA | Large Heavy Box | ✅ | 19 | UPSDAP, FedExDefault, USPS | $17.48 | 3414ms |
| 7 | San Francisco,CA → Fort Worth,TX | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $6.08 | 3798ms |
| 8 | San Francisco,CA → Memphis,TN | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 2117ms |
| 9 | San Francisco,CA → Baltimore,MD | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $40.76 | 3325ms |
| 10 | San Francisco,CA → Milwaukee,WI | Small Envelope | ✅ | 17 | USPS, FedExDefault, UPSDAP | $6.35 | 1742ms |
| 11 | Los Angeles,CA → Austin,TX | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $9.69 | 2115ms |
| 12 | Los Angeles,CA → Charlotte,NC | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $40.76 | 1960ms |
| 13 | Los Angeles,CA → Columbus,OH | Small Envelope | ✅ | 17 | USPS, FedExDefault, UPSDAP | $6.35 | 1715ms |
| 14 | Los Angeles,CA → Indianapolis,IN | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 1855ms |
| 15 | Los Angeles,CA → Jacksonville,FL | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $40.76 | 3343ms |
| 16 | Los Angeles,CA → San Jose,CA | Small Envelope | ✅ | 18 | USPS, UPSDAP, FedExDefault | $5.61 | 2003ms |
| 17 | Los Angeles,CA → Fort Worth,TX | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $9.69 | 2002ms |
| 18 | Los Angeles,CA → Memphis,TN | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $36.01 | 2145ms |
| 19 | Los Angeles,CA → Baltimore,MD | Small Envelope | ✅ | 17 | USPS, FedExDefault, UPSDAP | $6.35 | 7937ms |
| 20 | Los Angeles,CA → Milwaukee,WI | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.07 | 2008ms |
| 21 | New York,NY → Austin,TX | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $36.01 | 2208ms |
| 22 | New York,NY → Charlotte,NC | Small Envelope | ✅ | 18 | USPS, UPSDAP, FedExDefault | $5.75 | 9938ms |
| 23 | New York,NY → Columbus,OH | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $6.99 | 1982ms |
| 24 | New York,NY → Indianapolis,IN | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $24.83 | 5329ms |
| 25 | New York,NY → Jacksonville,FL | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 2421ms |
| 26 | New York,NY → San Jose,CA | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 1985ms |
| 27 | New York,NY → Fort Worth,TX | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $29.72 | 1953ms |
| 28 | New York,NY → Memphis,TN | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1811ms |
| 29 | New York,NY → Baltimore,MD | Medium Box | ✅ | 19 | UPSDAP, USPS, FedExDefault | $6.62 | 1796ms |
| 30 | New York,NY → Milwaukee,WI | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $24.83 | 3244ms |
| 31 | Chicago,IL → Austin,TX | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1748ms |
| 32 | Chicago,IL → Charlotte,NC | Medium Box | ✅ | 18 | USPS, UPSDAP, FedExDefault | $7.85 | 2090ms |
| 33 | Chicago,IL → Columbus,OH | Large Heavy Box | ✅ | 18 | UPSDAP, FedExDefault, USPS | $20.09 | 2053ms |
| 34 | Chicago,IL → Indianapolis,IN | Small Envelope | ✅ | 18 | USPS, UPSDAP, FedExDefault | $5.61 | 1844ms |
| 35 | Chicago,IL → Jacksonville,FL | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $8.19 | 2014ms |
| 36 | Chicago,IL → San Jose,CA | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $40.76 | 1910ms |
| 37 | Chicago,IL → Fort Worth,TX | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1852ms |
| 38 | Chicago,IL → Memphis,TN | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $6.99 | 1759ms |
| 39 | Chicago,IL → Baltimore,MD | Large Heavy Box | ✅ | 17 | FedExDefault, UPSDAP, USPS | $21.91 | 2586ms |
| 40 | Chicago,IL → Milwaukee,WI | Small Envelope | ✅ | 18 | USPS, UPSDAP, FedExDefault | $5.58 | 2120ms |
| 41 | Houston,TX → Austin,TX | Medium Box | ✅ | 19 | UPSDAP, USPS, FedExDefault | $6.62 | 1881ms |
| 42 | Houston,TX → Charlotte,NC | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $24.83 | 1762ms |
| 43 | Houston,TX → Columbus,OH | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1681ms |
| 44 | Houston,TX → Indianapolis,IN | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $8.19 | 1837ms |
| 45 | Houston,TX → Jacksonville,FL | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $24.83 | 1820ms |
| 46 | Houston,TX → San Jose,CA | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $6.08 | 1780ms |
| 47 | Houston,TX → Fort Worth,TX | Medium Box | ✅ | 19 | UPSDAP, USPS, FedExDefault | $6.77 | 1803ms |
| 48 | Houston,TX → Memphis,TN | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $21.14 | 1985ms |
| 49 | Houston,TX → Baltimore,MD | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.98 | 1664ms |
| 50 | Houston,TX → Milwaukee,WI | Medium Box | ✅ | 18 | UPSDAP, FedExDefault, USPS | $9.69 | 1839ms |
| 51 | Phoenix,AZ → Austin,TX | Large Heavy Box | ✅ | 17 | FedExDefault, UPSDAP, USPS | $25.81 | 1875ms |
| 52 | Phoenix,AZ → Charlotte,NC | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $6.08 | 1784ms |
| 53 | Phoenix,AZ → Columbus,OH | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $10.07 | 1908ms |
| 54 | Phoenix,AZ → Indianapolis,IN | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $36.01 | 1888ms |
| 55 | Phoenix,AZ → Jacksonville,FL | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $6.08 | 1683ms |
| 56 | Phoenix,AZ → San Jose,CA | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $8.19 | 2155ms |
| 57 | Phoenix,AZ → Fort Worth,TX | Large Heavy Box | ✅ | 15 | FedExDefault, UPSDAP | $25.81 | 2009ms |
| 58 | Phoenix,AZ → Memphis,TN | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.98 | 1490ms |
| 59 | Phoenix,AZ → Baltimore,MD | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $10.87 | 1780ms |
| 60 | Phoenix,AZ → Milwaukee,WI | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $36.01 | 1829ms |
| 61 | Philadelphia,PA → Austin,TX | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $6.08 | 1672ms |
| 62 | Philadelphia,PA → Charlotte,NC | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $6.99 | 2032ms |
| 63 | Philadelphia,PA → Columbus,OH | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $21.14 | 1801ms |
| 64 | Philadelphia,PA → Indianapolis,IN | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.06 | 1829ms |
| 65 | Philadelphia,PA → Jacksonville,FL | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $8.19 | 1829ms |
| 66 | Philadelphia,PA → San Jose,CA | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $40.76 | 1972ms |
| 67 | Philadelphia,PA → Fort Worth,TX | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.77 | 2015ms |
| 68 | Philadelphia,PA → Memphis,TN | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $8.19 | 2347ms |
| 69 | Philadelphia,PA → Baltimore,MD | Large Heavy Box | ✅ | 19 | UPSDAP, FedExDefault, USPS | $17.48 | 1978ms |
| 70 | Philadelphia,PA → Milwaukee,WI | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.36 | 1823ms |
| 71 | San Antonio,TX → Austin,TX | Medium Box | ✅ | 19 | UPSDAP, USPS, FedExDefault | $6.62 | 1573ms |
| 72 | San Antonio,TX → Charlotte,NC | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $29.72 | 1826ms |
| 73 | San Antonio,TX → Columbus,OH | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.98 | 2156ms |
| 74 | San Antonio,TX → Indianapolis,IN | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $8.19 | 2516ms |
| 75 | San Antonio,TX → Jacksonville,FL | Large Heavy Box | ✅ | 15 | FedExDefault, UPSDAP | $25.81 | 2155ms |
| 76 | San Antonio,TX → San Jose,CA | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.77 | 1901ms |
| 77 | San Antonio,TX → Fort Worth,TX | Medium Box | ✅ | 19 | UPSDAP, USPS, FedExDefault | $6.99 | 1901ms |
| 78 | San Antonio,TX → Memphis,TN | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $24.83 | 2206ms |
| 79 | San Antonio,TX → Baltimore,MD | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $6.08 | 1909ms |
| 80 | San Antonio,TX → Milwaukee,WI | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $9.69 | 1546ms |
| 81 | Dallas,TX → Austin,TX | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $20.09 | 1547ms |
| 82 | Dallas,TX → Charlotte,NC | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1818ms |
| 83 | Dallas,TX → Columbus,OH | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $8.19 | 1881ms |
| 84 | Dallas,TX → Indianapolis,IN | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $24.83 | 1961ms |
| 85 | Dallas,TX → Jacksonville,FL | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1884ms |
| 86 | Dallas,TX → San Jose,CA | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $10.07 | 1890ms |
| 87 | Dallas,TX → Fort Worth,TX | Large Heavy Box | ✅ | 19 | UPSDAP, FedExDefault, USPS | $17.48 | 1810ms |
| 88 | Dallas,TX → Memphis,TN | Small Envelope | ✅ | 15 | UPSDAP, FedExDefault | $7.67 | 1736ms |
| 89 | Dallas,TX → Baltimore,MD | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $9.69 | 1827ms |
| 90 | Dallas,TX → Milwaukee,WI | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $24.83 | 1941ms |
| 91 | San Diego,CA → Austin,TX | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.98 | 1523ms |
| 92 | San Diego,CA → Charlotte,NC | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 1859ms |
| 93 | San Diego,CA → Columbus,OH | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $40.76 | 1898ms |
| 94 | San Diego,CA → Indianapolis,IN | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.77 | 1801ms |
| 95 | San Diego,CA → Jacksonville,FL | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 1913ms |
| 96 | San Diego,CA → San Jose,CA | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $21.14 | 1830ms |
| 97 | San Diego,CA → Fort Worth,TX | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.77 | 1866ms |
| 98 | San Diego,CA → Memphis,TN | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.07 | 1984ms |
| 99 | San Diego,CA → Baltimore,MD | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $40.76 | 1820ms |
| 100 | San Diego,CA → Milwaukee,WI | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $6.08 | 1512ms |
| 101 | Denver,CO → Austin,TX | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $8.19 | 1780ms |
| 102 | Denver,CO → Charlotte,NC | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $29.72 | 3313ms |
| 103 | Denver,CO → Columbus,OH | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.98 | 1691ms |
| 104 | Denver,CO → Indianapolis,IN | Medium Box | ✅ | 18 | UPSDAP, FedExDefault, USPS | $9.69 | 1883ms |
| 105 | Denver,CO → Jacksonville,FL | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $36.01 | 1990ms |
| 106 | Denver,CO → San Jose,CA | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.36 | 1861ms |
| 107 | Denver,CO → Fort Worth,TX | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $8.19 | 1902ms |
| 108 | Denver,CO → Memphis,TN | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $24.83 | 2886ms |
| 109 | Denver,CO → Baltimore,MD | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.77 | 2927ms |
| 110 | Denver,CO → Milwaukee,WI | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $8.19 | 1920ms |
| 111 | Seattle,WA → Austin,TX | Large Heavy Box | ✅ | 17 | FedExDefault, UPSDAP, USPS | $37.65 | 1985ms |
| 112 | Seattle,WA → Charlotte,NC | Small Envelope | ✅ | 17 | USPS, FedExDefault, UPSDAP | $6.35 | 1763ms |
| 113 | Seattle,WA → Columbus,OH | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $10.87 | 1839ms |
| 114 | Seattle,WA → Indianapolis,IN | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $40.76 | 1853ms |
| 115 | Seattle,WA → Jacksonville,FL | Small Envelope | ✅ | 14 | FedExDefault, UPSDAP | $8.84 | 1671ms |
| 116 | Seattle,WA → San Jose,CA | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $8.19 | 1727ms |
| 117 | Seattle,WA → Fort Worth,TX | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $36.01 | 1564ms |
| 118 | Seattle,WA → Memphis,TN | Small Envelope | ✅ | 14 | FedExDefault, UPSDAP | $8.84 | 1849ms |
| 119 | Seattle,WA → Baltimore,MD | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 1739ms |
| 120 | Seattle,WA → Milwaukee,WI | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $36.01 | 1537ms |
| 121 | Boston,MA → Austin,TX | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.77 | 1721ms |
| 122 | Boston,MA → Charlotte,NC | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $8.19 | 1834ms |
| 123 | Boston,MA → Columbus,OH | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $24.83 | 1603ms |
| 124 | Boston,MA → Indianapolis,IN | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1492ms |
| 125 | Boston,MA → Jacksonville,FL | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $8.19 | 2050ms |
| 126 | Boston,MA → San Jose,CA | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $40.76 | 1833ms |
| 127 | Boston,MA → Fort Worth,TX | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.77 | 1791ms |
| 128 | Boston,MA → Memphis,TN | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $9.69 | 1719ms |
| 129 | Boston,MA → Baltimore,MD | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $21.14 | 1496ms |
| 130 | Boston,MA → Milwaukee,WI | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1725ms |
| 131 | Nashville,TN → Austin,TX | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $8.19 | 1702ms |
| 132 | Nashville,TN → Charlotte,NC | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $21.14 | 2123ms |
| 133 | Nashville,TN → Columbus,OH | Small Envelope | ✅ | 18 | USPS, UPSDAP, FedExDefault | $5.75 | 1822ms |
| 134 | Nashville,TN → Indianapolis,IN | Medium Box | ✅ | 19 | UPSDAP, USPS, FedExDefault | $6.77 | 1832ms |
| 135 | Nashville,TN → Jacksonville,FL | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $21.14 | 2002ms |
| 136 | Nashville,TN → San Jose,CA | Small Envelope | ✅ | 14 | FedExDefault, UPSDAP | $8.84 | 1804ms |
| 137 | Nashville,TN → Fort Worth,TX | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $8.19 | 1880ms |
| 138 | Nashville,TN → Memphis,TN | Large Heavy Box | ✅ | 18 | UPSDAP, FedExDefault, USPS | $20.09 | 1694ms |
| 139 | Nashville,TN → Baltimore,MD | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1550ms |
| 140 | Nashville,TN → Milwaukee,WI | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $6.99 | 2690ms |
| 141 | Portland,OR → Austin,TX | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $36.01 | 1863ms |
| 142 | Portland,OR → Charlotte,NC | Small Envelope | ✅ | 17 | USPS, FedExDefault, UPSDAP | $6.35 | 2963ms |
| 143 | Portland,OR → Columbus,OH | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 2514ms |
| 144 | Portland,OR → Indianapolis,IN | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $40.76 | 1883ms |
| 145 | Portland,OR → Jacksonville,FL | Small Envelope | ✅ | 17 | USPS, FedExDefault, UPSDAP | $6.35 | 1818ms |
| 146 | Portland,OR → San Jose,CA | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $8.19 | 2142ms |
| 147 | Portland,OR → Fort Worth,TX | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $36.01 | 1756ms |
| 148 | Portland,OR → Memphis,TN | Small Envelope | ✅ | 17 | USPS, FedExDefault, UPSDAP | $6.35 | 1722ms |
| 149 | Portland,OR → Baltimore,MD | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 1814ms |
| 150 | Portland,OR → Milwaukee,WI | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $36.01 | 1863ms |
| 151 | Las Vegas,NV → Austin,TX | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.77 | 1757ms |
| 152 | Las Vegas,NV → Charlotte,NC | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 1863ms |
| 153 | Las Vegas,NV → Columbus,OH | Large Heavy Box | ✅ | 15 | FedExDefault, UPSDAP | $37.65 | 1872ms |
| 154 | Las Vegas,NV → Indianapolis,IN | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $6.08 | 2010ms |
| 155 | Las Vegas,NV → Jacksonville,FL | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $10.87 | 1861ms |
| 156 | Las Vegas,NV → San Jose,CA | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $21.14 | 1797ms |
| 157 | Las Vegas,NV → Fort Worth,TX | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.98 | 1449ms |
| 158 | Las Vegas,NV → Memphis,TN | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.07 | 4608ms |
| 159 | Las Vegas,NV → Baltimore,MD | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $40.76 | 1809ms |
| 160 | Las Vegas,NV → Milwaukee,WI | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $6.08 | 1647ms |
| 161 | Miami,FL → Austin,TX | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $9.69 | 1825ms |
| 162 | Miami,FL → Charlotte,NC | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $24.83 | 1579ms |
| 163 | Miami,FL → Columbus,OH | Small Envelope | ✅ | 15 | FedExDefault, UPSDAP | $8.36 | 1748ms |
| 164 | Miami,FL → Indianapolis,IN | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $10.07 | 2004ms |
| 165 | Miami,FL → Jacksonville,FL | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $21.14 | 1707ms |
| 166 | Miami,FL → San Jose,CA | Small Envelope | ✅ | 14 | FedExDefault, UPSDAP | $8.84 | 1850ms |
| 167 | Miami,FL → Fort Worth,TX | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $9.69 | 1911ms |
| 168 | Miami,FL → Memphis,TN | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $24.83 | 1747ms |
| 169 | Miami,FL → Baltimore,MD | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1711ms |
| 170 | Miami,FL → Milwaukee,WI | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $9.69 | 1985ms |
| 171 | Atlanta,GA → Austin,TX | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $24.83 | 1855ms |
| 172 | Atlanta,GA → Charlotte,NC | Small Envelope | ✅ | 18 | USPS, UPSDAP, FedExDefault | $5.61 | 1603ms |
| 173 | Atlanta,GA → Columbus,OH | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $6.99 | 1803ms |
| 174 | Atlanta,GA → Indianapolis,IN | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $21.14 | 1945ms |
| 175 | Atlanta,GA → Jacksonville,FL | Small Envelope | ✅ | 15 | UPSDAP, FedExDefault | $7.57 | 1843ms |
| 176 | Atlanta,GA → San Jose,CA | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $10.87 | 1853ms |
| 177 | Atlanta,GA → Fort Worth,TX | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $24.83 | 2186ms |
| 178 | Atlanta,GA → Memphis,TN | Small Envelope | ✅ | 15 | UPSDAP, FedExDefault | $7.67 | 1878ms |
| 179 | Atlanta,GA → Baltimore,MD | Medium Box | ✅ | 18 | USPS, UPSDAP, FedExDefault | $7.85 | 1543ms |
| 180 | Atlanta,GA → Milwaukee,WI | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $24.83 | 1782ms |
| 181 | Minneapolis,MN → Austin,TX | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.98 | 1829ms |
| 182 | Minneapolis,MN → Charlotte,NC | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $8.19 | 1723ms |
| 183 | Minneapolis,MN → Columbus,OH | Large Heavy Box | ✅ | 15 | FedExDefault, UPSDAP | $21.91 | 1833ms |
| 184 | Minneapolis,MN → Indianapolis,IN | Small Envelope | ✅ | 15 | UPSDAP, FedExDefault | $7.67 | 1982ms |
| 185 | Minneapolis,MN → Jacksonville,FL | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $9.69 | 1703ms |
| 186 | Minneapolis,MN → San Jose,CA | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $36.01 | 1848ms |
| 187 | Minneapolis,MN → Fort Worth,TX | Small Envelope | ✅ | 18 | USPS, FedExDefault, UPSDAP | $5.83 | 1612ms |
| 188 | Minneapolis,MN → Memphis,TN | Medium Box | ✅ | 18 | UPSDAP, USPS, FedExDefault | $8.19 | 1610ms |
| 189 | Minneapolis,MN → Baltimore,MD | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $24.83 | 1915ms |
| 190 | Minneapolis,MN → Milwaukee,WI | Small Envelope | ✅ | 15 | UPSDAP, FedExDefault | $7.57 | 1874ms |
| 191 | Detroit,MI → Austin,TX | Medium Box | ✅ | 15 | UPSDAP, FedExDefault | $9.69 | 1914ms |
| 192 | Detroit,MI → Charlotte,NC | Large Heavy Box | ✅ | 17 | UPSDAP, FedExDefault, USPS | $21.14 | 1710ms |
| 193 | Detroit,MI → Columbus,OH | Small Envelope | ✅ | 18 | USPS, UPSDAP, FedExDefault | $5.61 | 1806ms |
| 194 | Detroit,MI → Indianapolis,IN | Medium Box | ✅ | 19 | UPSDAP, USPS, FedExDefault | $6.77 | 1832ms |
| 195 | Detroit,MI → Jacksonville,FL | Large Heavy Box | ✅ | 15 | UPSDAP, FedExDefault | $24.83 | 1846ms |
| 196 | Detroit,MI → San Jose,CA | Small Envelope | ✅ | 14 | FedExDefault, UPSDAP | $8.84 | 1779ms |
| 197 | Detroit,MI → Fort Worth,TX | Medium Box | ✅ | 18 | UPSDAP, FedExDefault, USPS | $9.69 | 1692ms |
| 198 | Detroit,MI → Memphis,TN | Large Heavy Box | ✅ | 15 | FedExDefault, UPSDAP | $21.91 | 2007ms |
| 199 | Detroit,MI → Baltimore,MD | Small Envelope | ✅ | 18 | USPS, UPSDAP, FedExDefault | $5.75 | 2456ms |
| 200 | Detroit,MI → Milwaukee,WI | Medium Box | ✅ | 16 | UPSDAP, FedExDefault | $6.77 | 2456ms |
| 201 | [BAD] Bad Address 1 → Austin,TX | Small Envelope | ✅ | 0 | — | — | 1473ms |
| 202 | [BAD] Bad Address 2 → Austin,TX | Small Envelope | ✅ | 0 | — | — | 1111ms |
| 203 | [BAD] Bad Address 3 → Austin,TX | Small Envelope | ✅ | 0 | — | — | 1156ms |
| 204 | [BAD] Missing Fields → Austin,TX | Small Envelope | ✅ | 0 | — | — | 8653ms |
| 205 | [BAD] Bad Zip → Austin,TX | Small Envelope | ✅ | 4 | USPS, FedExDefault | $6.08 | 1406ms |

</details>
