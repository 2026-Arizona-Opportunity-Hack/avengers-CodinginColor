# Mobile accessibility audit, November 15, 2026

Source: main `bd97b07` plus this PR's three layout fixes. Production Angular build passed with Node 24.15.0. A dedicated headless Chrome profile served the compiled static build on loopback with synthetic demo data and the demo admin session; public routes show their demo/unconfigured states.

Lighthouse 13.6.0 **snapshot** accessibility audits, 390 x 844 viewport, reduced motion requested. Each route below rendered its own expected title and heading. Every route had document width 390px and no active animations longer than 1ms. Scores do not establish every accessibility requirement.

| Route | Accessibility |
|---|---:|
| `/sign-in` | 100 |
| `/` | 100 |
| `/donors` | 96 |
| `/donors/new` | 100 |
| `/donations` | 100 |
| `/outreach` | 100 |
| `/import` | 100 |
| `/retention` | 100 |
| `/funders` | 100 |
| `/api` | 100 |
| `/settings` | 100 |
| `/not-connected` | 100 |
| `/account` | 100 |
| `/ask` | 100 |
| `/impact` | 100 |
| `/sign-up` | 100 |
| `/setup-security` | 100 |
| `/donors/d-025` | 100 |

Before the fix, the document overflowed to 441px on overview, 430px on retention, 502px on funders, and 406px on other shell routes. The search flex item and chart panels now shrink; the gift table scrolls within a named, focusable region. Printing restores visible overflow.

Keyboard browser checks passed: focusing the gift-history region and pressing ArrowRight scrolls it 40px; Enter on global search opens the command dialog and focuses its search input; Escape closes it. Screenshot: [funder report at 390px](mobile-funder-390.png).

Remaining evidence: donor list has Lighthouse touch-target findings (score 96); full keyboard workflows, all dynamic states and authenticated live-mode journeys were not audited. Issue #73 stays open for that acceptance, and #30 remains the deployment gate. No donor provider/account operations were performed.
