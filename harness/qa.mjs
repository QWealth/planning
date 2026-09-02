// THROWAWAY. Drives the reorder flow and reports what actually happened.
const laneNames = (page) =>
  page.$$eval('[id^="lane-"] span', (els) =>
    els
      .filter((e) => /^(Alpha|Bravo|Charlie|Delta)$/.test(e.textContent.trim()))
      .map((e) => e.textContent.trim())
  );

const patchLog = (page) => page.$eval('#patch-log', (e) => e.textContent.trim());

export default async function run(page, ui) {
  const out = {};

  await page.waitForSelector('[id^="lane-"]');
  out.initialOrder = await laneNames(page);

  // Before reordering, each lane offers Edit and no move controls.
  out.editBeforeReorder = await page.locator('button:text-is("Edit")').count();
  out.movesBeforeReorder = await page.getByLabel(/^Move .* up$/).count();

  // Enter the mode.
  await page.getByRole('button', { name: 'Reorder' }).click();
  out.hintOnEntry = await page.locator('text=/Use the arrows/').count();
  out.editDuringReorder = await page.locator('button:text-is("Edit")').count();
  out.movesDuringReorder = await page.getByLabel(/^Move .* up$/).count();
  out.saveDisabledWithNoChanges = await page
    .getByRole('button', { name: 'Save order' })
    .isDisabled();

  // Ends of the list are unreachable.
  out.alphaUpDisabled = await page.getByLabel('Move Alpha up').isDisabled();
  out.deltaDownDisabled = await page.getByLabel('Move Delta down').isDisabled();

  // THE CASE THAT MATTERS: Alpha and Bravo both have lane_order 0. Move Bravo up.
  // A swap-based implementation writes 0 and 0 and nothing moves.
  await page.getByLabel('Move Bravo up').click();
  out.afterMovingBravoUp = await laneNames(page);
  out.patchesBeforeSave = await patchLog(page);
  out.saveEnabledAfterMove = await page
    .getByRole('button', { name: 'Save order' })
    .isEnabled();
  out.hintAfterMove = await page.locator('text=/will be renumbered/').textContent();

  // Move Delta to the top with three presses on the same control, which is the
  // interaction most likely to break: the row slides away from the pointer.
  for (let i = 0; i < 3; i += 1) {
    await page.getByLabel('Move Delta up').click();
  }
  out.afterMovingDeltaToTop = await laneNames(page);

  // Cancel restores the stored order and writes nothing.
  await page.getByRole('button', { name: 'Cancel' }).click();
  out.afterCancel = await laneNames(page);
  out.patchesAfterCancel = await patchLog(page);
  out.backToEditAfterCancel = await page.locator('button:text-is("Edit")').count();

  // Now do it for real and save.
  await page.getByRole('button', { name: 'Reorder' }).click();
  await page.getByLabel('Move Delta up').click();
  await page.getByLabel('Move Delta up').click();
  await page.getByLabel('Move Delta up').click();
  out.draftBeforeSave = await laneNames(page);
  await page.getByRole('button', { name: 'Save order' }).click();
  await page.waitForSelector('button:text-is("Reorder")');
  out.afterSave = await laneNames(page);
  out.patchesOnSave = await patchLog(page);

  // The saved order must SURVIVE a re-sort from the stored numbers, which is the
  // real test: the page applies the change set to state and re-sorts by lane_order.
  await page.getByRole('button', { name: 'Reorder' }).click();
  out.saveDisabledAfterSaving = await page
    .getByRole('button', { name: 'Save order' })
    .isDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  out.finalOrder = await laneNames(page);

  return out;
}
