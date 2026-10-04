# Answer key

Correct answers for the test questions in Step 8 of the setup guide. The sections before "Bonus questions" were generated together with the data; the bonus section was added by hand from the CSV files. The data generator is not in this repo, so if the data changes, update this file and the checks in `eval/run_eval.py` by hand.

## Department spend, Q3 2026 vs Q2 2026

| department | Q2 2026 | Q3 2026 | growth | Q3 budget | vs budget |
|---|---|---|---|---|---|
| engineering | 645,440 | 669,080 | +4% | 686,200 | -2% |
| marketing | 565,991 | 842,712 | +49% | 905,700 | -7% |
| sales | 287,456 | 378,078 | +32% | 305,800 | +24% |
| hr | 201,537 | 207,813 | +3% | 215,700 | -4% |
| finance | 158,223 | 171,979 | +9% | 176,400 | -3% |
| operations | 402,619 | 418,389 | +4% | 435,200 | -4% |

## AWS costs

Total: Q2 2026 = 91,051 USD, Q3 2026 = 144,550 USD (+59%)

| account | Q2 2026 | Q3 2026 | change |
|---|---|---|---|
| engineering-prod | 42,071 | 53,889 | +11,819 |
| engineering-dev | 6,328 | 6,657 | +329 |
| data-platform | 28,479 | 69,259 | +40,780 |
| marketing-web | 6,114 | 6,344 | +230 |
| finance-erp | 5,508 | 5,760 | +252 |
| shared-services | 2,551 | 2,640 | +89 |

Biggest drivers of the Q3 increase:

- AmazonEC2 `EU-BoxUsage:g5.12xlarge`: +31,615 USD
- AmazonEC2 `EU-NatGateway-Bytes`: +10,465 USD
- AmazonBedrock `EU-InputTokenCount`: +8,299 USD

Untagged spend (no department tag): Q2 2026 = 0 USD, Q3 2026 = 31,615 USD - the new g5.12xlarge GPU instances in data-platform.

NAT Gateway cost by month, 2026 (spike in August):

- 2026-01: 685 USD
- 2026-02: 624 USD
- 2026-03: 708 USD
- 2026-04: 686 USD
- 2026-05: 718 USD
- 2026-06: 689 USD
- 2026-07: 721 USD
- 2026-08: 11,116 USD
- 2026-09: 721 USD

## Bonus questions

Answers for the bonus questions in Step 8 of the setup guide.

### Which vendors drove marketing's increase?

Marketing advertising moved away from AdReach to two other vendors:

| vendor | Q2 2026 | Q3 2026 | change |
|---|---|---|---|
| SocialBoost | 76,228 | 324,955 | +248,727 |
| SearchAds Pro | 26,034 | 261,545 | +235,511 |
| AdReach | 215,896 | 0 | -215,896 |

Advertising overall: Q2 2026 = 318,157 USD, Q3 2026 = 586,499 USD (+268,342).

### How much did our Bedrock costs grow last quarter?

Q2 2026 = 7,978 USD, Q3 2026 = 16,276 USD (+104%). All of it is input tokens (`EU-InputTokenCount`) in the data-platform account. The growth is steady, about 26% a month over the last year: 402 USD in September 2025, 6,612 USD in September 2026.

### How much of our AWS spend was untagged last quarter?

Q3 2026: 31,615 USD of 144,550 USD (21.9%). Nothing was untagged before July 2026. All of it is the new g5.12xlarge GPU instances in data-platform, running since 2026-07-01.

### Has any department ever gone over budget?

Only sales, in Q3 2026: 378,078 USD against a budget of 305,800 USD (+23.6%). Every other department stayed within budget in every quarter from 2024-Q4 to 2026-Q3.

### How does Q3 2026 compare with the same quarter last year?

| department | Q3 2025 | Q3 2026 | change |
|---|---|---|---|
| engineering | 579,946 | 669,080 | +15% |
| marketing | 524,799 | 842,712 | +61% |
| sales | 256,773 | 378,078 | +47% |
| hr | 179,598 | 207,813 | +16% |
| finance | 149,066 | 171,979 | +15% |
| operations | 370,492 | 418,389 | +13% |
| total | 2,060,674 | 2,688,052 | +30% |

AWS costs (a separate table): Q3 2025 = 77,520 USD, Q3 2026 = 144,550 USD (+86%).
