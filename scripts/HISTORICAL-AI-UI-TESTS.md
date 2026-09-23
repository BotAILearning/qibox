# Historical AI UI browser tests

These browser scripts remain available for manual investigation, but they are not part of `npm run test:ai-ui` because they assert against older screens or controls. Update a script to the current UI before putting it back in the active suite; do not treat its failure as a current product regression without first checking the current interaction.

| Script | Why it is historical |
| --- | --- |
| `test-batch2-ui.mjs` | Uses the retired `#ai-content [data-ai-nav=provider]` route. |
| `test-ai-fixes-ui.mjs` | Assumes the old learning completion toast and overview navigation. |
| `test-layout060-ui.mjs` | Navigates to the retired provider tab and checks its former layout. |
| `test-development061-ui.mjs` | Depends on superseded master-control and settings-panel DOM assumptions. |
| `test-development062-ui.mjs` | Enforces a fixed expanded-card height from the older layout. |
| `test-proactive070-ui.mjs` | Waits for the retired `[data-proactive-record]` element. |
| `test-repair071-ui.mjs` | Requires the former side-by-side analysis layout; the current page places the report below setup. |

The active suite is intentionally focused on current product coverage: model setup, one-request multi-contact analysis, analysis history and copy, contact search, date bounds, and the native file handoff exercised alongside analysis.
