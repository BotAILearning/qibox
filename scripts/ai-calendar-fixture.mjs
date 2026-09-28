export function calendarFixture(bridge) {
  bridge.readDates=async args=>({account:args.account,contact:args.contact,dates:['2026-09-01','2026-09-02']});
}
export async function selectSeptemberRange(page) {
  if (await page.locator('[data-ai-analysis-range=custom]').count()) {
    await page.locator('[data-ai-analysis-range=custom]').click();
  } else {
    await page.locator('[data-ai-date-range]').click();
  }
  const dialog = page.locator('.ai-calendar-dialog');
  await dialog.waitFor({ state: 'visible' });
  if (await dialog.locator('[data-mode=custom]').count()) await dialog.locator('[data-mode=custom]').click();
  await page.locator('[data-day="2026-09-01"]').click();await page.locator('[data-day="2026-09-02"]').click();
  await dialog.locator('[data-apply]').click();await dialog.waitFor({state:'detached'});
}
