import assert from 'node:assert/strict';

// Shared current-UI check replacing retired five-step-wizard assertions.
export async function proactiveDraftCheck(page) {
  await page.locator('.ai-main-tabs [data-ai-nav=proactive]').click();
  await page.locator('[data-proactive-new]').click();
  assert.equal(await page.locator('.ai-steps').count(), 0);
  await page.locator('#ai-proactive-form [name=name]').fill('草稿保留验收');
  await page.locator('[data-proactive-pick]').click();
  assert.equal(await page.locator('[data-proactive-contact]:checked').count(), 0);
  await page.locator('[data-proactive-contact]').first().check();
  await page.locator('[data-proactive-picker-confirm]').click();
  await page.locator('#ai-proactive-form [name=goal]').fill('确认周末安排');
  await page.locator('#ai-proactive-form [name=requirements]').fill('不要承诺具体地点');
  await page.locator('[data-proactive-back]').click();
  await page.locator('[data-proactive-new]').click();
  assert.equal(await page.locator('#ai-proactive-form [name=goal]').inputValue(), '确认周末安排');
  assert.equal(await page.locator('#ai-proactive-selected .ap-chip').count(), 1);
  await page.locator('[data-proactive-pick]').click();
  await page.locator('[data-proactive-clear]').click();
  await page.locator('[data-proactive-picker-cancel]').last().click();
  assert.equal(await page.locator('#ai-proactive-selected .ap-chip').count(), 1);
  await page.locator('#ai-proactive-form [name=cycle]').selectOption('weekly');
  await page.locator('#ai-proactive-form [name=mode]').selectOption('random');
  assert.equal(await page.locator('#ai-proactive-form [name=start]').isVisible(), true);
  assert.equal(await page.locator('#ai-proactive-form [name=weekdays]').count(), 7);
  await page.locator('[data-proactive-cancel]').click();
}

export async function proactiveCommand(page, id, command) {
  await page.locator(`[data-proactive-menu="${id}"]`).click();
  await page.locator(`[data-proactive-command="${command}"][data-task-id="${id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') !== 'true');
}
