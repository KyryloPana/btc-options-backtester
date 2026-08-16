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
            <th>Research</th><th>⌄</th><th>Estimate quality</th><th>Spread and both strikes</th><th>Expiry</th><th>Width</th>
            <th>Estimated gross entry</th><th>Estimated net opening</th><th>Best estimated unrealized PnL</th>
            <th>Max estimated adverse PnL</th><th>Estimated selected outcome</th>
          </tr></thead><tbody><tr>
            <td><label class="research-select"><input type="checkbox" checked /><small>SAVED</small></label></td><td><button class="expand-button">⌃</button></td><td><span class="flag flag-yellow">yellow</span><small>Confidence label, not execution proof</small></td>
            <td><strong>BTC put credit spread with a deliberately long contract description</strong><small class="mono">BTC-29DEC28-100000-P / BTC-29DEC28-90000-P</small></td>
            <td>Friday, 29 Dec 2028</td><td>$10,000.00</td><td>BTC 0.12345678</td><td>BTC 0.09876543</td>
            <td class="positive">$123,456.78</td><td class="negative">−$98,765.43</td><td>Estimated valuation</td>
          </tr><tr class="collapsed-sibling">
            <td><label class="research-select"><input type="checkbox" disabled /></label></td><td><button class="expand-button">⌄</button></td><td><span class="flag flag-yellow">yellow</span></td>
            <td><strong>Compact sibling structure</strong></td><td>Friday, 29 Dec 2028</td><td>$10,000.00</td><td>BTC 0.12345678</td><td>BTC 0.09876543</td>
            <td class="positive">$123,456.78</td><td class="negative">−$98,765.43</td><td>Estimated valuation</td>
          </tr><tr class="ledger-detail-row"><td colspan="11"><div class="ledger-pair">
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
        const rows = [...block.querySelectorAll("tbody > tr")];
        const scroller = block.querySelector(".table-scroll");
        return {
          pageClientWidth: document.documentElement.clientWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          headerHeight: block.querySelector("thead").getBoundingClientRect().height,
          firstRowHeight: rows[0].getBoundingClientRect().height,
          siblingRowHeight: rows[1].getBoundingClientRect().height,
          detailRowHeight: rows[2].getBoundingClientRect().height,
          scrollClientWidth: scroller.clientWidth,
          scrollWidth: scroller.scrollWidth,
          checkboxSizes: [...block.querySelectorAll(".research-select input")].map(input => ({width: input.getBoundingClientRect().width, height: input.getBoundingClientRect().height})),
          savedWritingMode: getComputedStyle(block.querySelector(".research-select small")).writingMode,
          savedWidth: block.querySelector(".research-select small").getBoundingClientRect().width,
        };
      });
      assert.equal(result.pageScrollWidth, result.pageClientWidth, `${width}px page overflow`);
      assert.ok(result.headerHeight < 90, `${width}px oversized header: ${JSON.stringify(result)}`);
      assert.ok(result.firstRowHeight < 120, `${width}px oversized collapsed row: ${JSON.stringify(result)}`);
      assert.ok(result.siblingRowHeight < 120, `${width}px stretched sibling row: ${JSON.stringify(result)}`);
      assert.ok(result.detailRowHeight > result.siblingRowHeight, `${width}px detail did not add content height`);
      assert.ok(result.checkboxSizes.every(size => size.width >= 14 && size.width <= 16 && size.height >= 14 && size.height <= 16), `${width}px research checkbox sizing`);
      assert.equal(result.savedWritingMode, "horizontal-tb");
      assert.ok(result.savedWidth > 30, `${width}px SAVED wrapped vertically`);
      if (width === 1024) assert.ok(result.scrollWidth > result.scrollClientWidth, "narrow matrix should scroll horizontally");
    }

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("[data-testid=pnl-block]").screenshot({ path: "artifacts/pnl-block-1440.png" });
  } finally {
    await browser.close();
  }
});
