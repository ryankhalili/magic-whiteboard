/** Run inside an existing ego-browser task space on a separate test origin.
 * const { runPdfLibrarySmoke } = await import('/absolute/repo/tests/browser/ego-pdf-library-smoke.js')
 * console.log(await runPdfLibrarySmoke(page, '/absolute/output/directory'))
 * Uses a synthetic PDF and ordinary UI controls. Makes no paid AI requests.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'

export async function runPdfLibrarySmoke(page, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true })
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  doc.setTitle('Integration Algebra Workbook')
  for (let i = 1; i <= 2; i++) {
    const sheet = doc.addPage([612, 792])
    for (const [text, y, size] of [
      ['Integration Algebra Workbook', 735, 22], [`Section ${i}.1 - Equations`, 690, 18],
      [`Example ${i}.1`, 635, 16], ['Solve x + 3 = 7. Subtract 3 from both sides: x = 4.', 605, 13],
      ['Exercises', 535, 18], ['1. Solve 3x + 2 = 11.', 495, 14], ['2. Sketch y = x^2.', 450, 14],
    ]) sheet.drawText(text, { x: 55, y, size, font })
    sheet.drawText(String(i), { x: 300, y: 30, size: 12, font })
  }
  const fixture = path.join(outputDirectory, 'integration-workbook.pdf')
  await writeFile(fixture, await doc.save())
  const checks = [], name = `PDF integration ${Date.now()}`
  const button = name => page.click(`loc=role:button[name=${JSON.stringify(name)}]`)
  const count = n => page.waitForFunction(n => Number(document.querySelector('.canvas-status')?.textContent.match(/(\d+) objects?/)?.[1]) === n, n)
  const saved = () => page.waitForFunction(() => document.querySelector('.document-title > span')?.textContent === 'Saved on this device')
  const newNotebook = async title => {
    await button('Notebooks')
    await page.fill('input[placeholder="New notebook name"]', title)
    await button('Create'); await count(0)
  }
  const importPdf = async target => {
    const waiting = page.waitForFileChooser({ timeout: 10_000 })
    await button('Import')
    await (await waiting).setFiles(fixture)
    await page.waitForFunction(() => document.querySelector('.import-file')?.textContent.includes('2 pages'))
    await page.click(`loc=role:button[name*=${JSON.stringify(target)}]`)
    await page.waitForFunction(() => !document.querySelector('.import-dialog'))
  }
  const download = async (label, fileName) => {
    await button('Export')
    const waiting = page.waitForEvent('download', { timeout: 30_000 })
    await page.click(`loc=role:button[name*=${JSON.stringify(label)}]`)
    const result = path.join(outputDirectory, fileName)
    await (await waiting).saveAs(result)
    return result
  }

  await newNotebook(name)
  await importPdf('Put on the board'); await count(2)
  await button('Undo'); await count(0)
  await button('Redo'); await count(2); await saved()
  await page.reload(); await count(2)
  await button('Fit canvas')
  checks.push('Multi-page PDF import, undo/redo, persistence and reload')

  await importPdf('Save to library')
  await page.fill('input[aria-label="Search this book"]', 'Example 2.1')
  await button('Search')
  await page.waitForSelector('.reference-legend-list button')
  await page.click('.reference-legend-list button')
  await button('Insert match 1: Example 2.1, p. 2'); await count(3)
  await button('Close book')
  await page.waitForFunction(() => document.querySelector('select[aria-label="Choose board object"] option:checked')?.textContent === 'Book excerpt: Example 2.1 (page 2)')
  checks.push('Library indexing, search and exact example crop insertion')

  const pdf = await download('Selected area PDF', 'selected-area.pdf')
  const png = await download('PNG image', 'board.png')
  const backup = await download('Editable notebook', 'board.marginalia.json')
  checks.push('Selected-area PDF, board PNG and editable backup downloads')

  await newNotebook(`${name} restored`)
  await button('Infinite canvas')
  const waiting = page.waitForFileChooser({ timeout: 10_000 })
  await button('Open notebook file')
  await (await waiting).setFiles(backup)
  await count(3); await saved()
  await page.reload(); await count(3)
  await button('Fit canvas')
  checks.push('Editable backup restores pages and crop in another notebook after reload')

  await button('Generate image')
  await page.fill('textarea[aria-label="Image description"]', 'A labeled triangle')
  await page.waitForSelector('[aria-label="Image placement preview"]')
  await button('Dismiss image preview'); await count(3)
  checks.push('Image generation review and dismissal without a paid request')
  const error = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent)
  if (error) throw new Error(error)
  return { name, checks, objects: 3, pdf, png, backup }
}
