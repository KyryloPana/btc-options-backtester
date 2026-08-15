import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

const viewports = [1024, 1366, 1440, 1920];
const appUrl = process.env.TEST_BASE_URL ?? "http://127.0.0.1:4173";

test("generated PnL table and expanded payoff stay inside their block", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(appUrl, { waitUntil: "networkidle" });

    // Use the production component classes with deliberately long, representative
    // values. This makes the layout regression deterministic without depending on
    // an exchange API or on a particular saved research dataset.
    await page.locator("[data-testid=pnl-block]").evaluate(block => {
      block.innerHTML = `
        <div class="table-card card"><div class="table-scroll">
          <table class="pnl-results-table"><thead><tr>
            <th>⌄</th><th>Estimate quality</th><th>Spread and both strikes</th><th>Expiry</th><th>Width</th>
            <th>Estimated gross entry</th><th>Estimated net opening</th><th>Best estimated unrealized PnL</th>
            <th>Max estimated adverse PnL</th><th>Estimated selected outcome</th>
          </tr></thead><tbody><tr>
            <td><button class="expand-button">⌃</button></td><td><span class="flag flag-yellow">yellow</span><small>Confidence label, not execution proof</small></td>
            <td><strong>BTC put credit spread with a deliberately long contract description</strong><small class="mono">BTC-29DEC28-100000-P / BTC-29DEC28-90000-P</small></td>
            <td>Friday, 29 Dec 2028</td><td>$10,000.00</td><td>BTC 0.12345678</td><td>BTC 0.09876543</td>
            <td class="positive">$123,456.78</td><td class="negative">−$98,765.43</td><td>Estimated valuation</td>
          </tr><tr class="ledger-detail-row"><td colspan="10"><div class="ledger-pair">
            <section class="opening-ledger"><h4>Research estimate evidence</h4><p>Historical observations are estimates and this deliberately long sentence must wrap within the evidence panel.</p>
              <dl><div><dt>Contracts</dt><dd class="mono">BTC-29DEC28-100000-P / BTC-29DEC28-90000-P</dd></div><div><dt>Evidence window</dt><dd>±720 minutes</dd></div><div><dt>Leg prices</dt><dd>0.12345678 / 0.09876543 BTC</dd></div><div><dt>Source / quality</dt><dd>model-reconstructed · yellow</dd></div></dl>
            </section><section class="expiry-payoff"><h4>Expiry payoff</h4><div class="payoff-plot"><svg viewBox="0 0 600 230" aria-label="Payoff chart"><path d="M0 180 L300 180 L450 50 L600 50" class="payoff-curve"/></svg></div>
              <div class="payoff-inspector"><span><small>Index</small><strong>$100,000.00</strong></span><span><small>PnL</small><strong>$123,456.78</strong></span><span><small>Maximum profit</small><strong>$98,765.43</strong></span><span><small>Maximum loss</small><strong>−$876,543.21</strong></span><span><small>Break-even</small><strong>$99,123.45</strong></span></div>
            </section></div></td></tr></tbody></table>
        </div>`;
    });

    for (const width of viewports) {
      await page.setViewportSize({ width, height: 1000 });
      const result = await page.locator("[data-testid=pnl-block]").evaluate(block => {
        const boundary = block.getBoundingClientRect();
        const offenders = [...block.querySelectorAll("*")].filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.right > boundary.right + 1 || rect.left < boundary.left - 1;
        }).map(element => `${element.tagName}.${element.className}`);
        return {
          clientWidth: block.clientWidth,
          scrollWidth: block.scrollWidth,
          pageClientWidth: document.documentElement.clientWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          offenders,
        };
      });
      assert.ok(result.scrollWidth <= result.clientWidth + 1, `${width}px PnL overflow: ${JSON.stringify(result)}`);
      assert.equal(result.pageScrollWidth, result.pageClientWidth, `${width}px page overflow`);
      assert.deepEqual(result.offenders, [], `${width}px descendants exceed the PnL boundary`);
    }

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("[data-testid=pnl-block]").screenshot({ path: "artifacts/pnl-block-1440.png" });
  } finally {
    await browser.close();
  }
});
