export function calendarFixture(bridge) {
  bridge.readDates=async args=>({account:args.account,contact:args.contact,dates:['2026-09-01','2026-09-02']});
}
export async function selectSeptemberRange(page) {
  if (await page.locator('[data-ai-analysis-range=custom]').count()) await page.locator('[data-ai-analysis-range=custom]').click();
  await page.locator('[data-ai-date-range]').click();await page.locator('[data-mode=custom]').click();
  await page.locator('[data-day="2026-09-01"]').click();await page.locator('[data-day="2026-09-02"]').click();
  await page.locator('[data-apply]').click();await page.locator('.ai-calendar-dialog').waitFor({state:'detached'});
}
