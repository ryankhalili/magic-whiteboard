/** Run inside one existing ego-browser task space; use a desktop viewport (1440 × 1000).
 * const { runInteractiveMathSmoke } = await import('/absolute/repo/tests/browser/ego-interactive-math-smoke.js')
 * console.log(await runInteractiveMathSmoke(page))
 * Uses ordinary UI actions and DOM observations. No AI requests or private app APIs.
 */
export async function runInteractiveMathSmoke(page) {
  const report = [], name = `Math port smoke ${Date.now()}`
  const check = (ok, message) => { if (!ok) throw new Error(message) }
  const button = name => page.click(`loc=role:button[name=${JSON.stringify(name)}]`)
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const count = expected => page.waitForFunction(n => Number(document.querySelector('.canvas-status')?.textContent.match(/(\d+) objects?/)?.[1]) === n, expected)
  const saved = () => page.waitForFunction(() => document.querySelector('.document-title > span')?.textContent === 'Saved on this device')
  const choose = label => page.selectOption('select[aria-label="Choose board object"]', { label })
  const source = 'textarea[aria-label="Object content"]'
  const expectSource = value => page.waitForFunction(v => document.querySelector('textarea[aria-label="Object content"]')?.value === v, value)
  const bounds = id => page.evaluate(id => document.querySelector(`[data-shape-id="${id}"]`).getBoundingClientRect().toJSON(), id)
  const expectBounds = (id, expected) => page.waitForFunction(({ id, expected }) => {
    const b = document.querySelector(`[data-shape-id="${id}"]`)?.getBoundingClientRect()
    return b && Object.keys(expected).every(key => Math.abs(b[key] - expected[key]) < 2)
  }, { id, expected })
  const drag = async (x, y, dx, dy) => {
    await page.mouse.move(x, y); await page.mouse.down()
    try { await page.mouse.move(x + dx, y + dy, { steps: 12, label: 'Test native canvas drag' }) }
    finally { await page.mouse.up() }
    await frames()
  }

  await button('Notebooks')
  await page.fill('input[placeholder="New notebook name"]', name)
  await button('Create'); await count(0)
  await button('Try an example'); await count(4)
  await page.fill('input[aria-label="Notebook title"]', name); await saved()
  await page.reload(); await count(4)
  await choose('Graph: sin(x)'); await frames()
  const graphId = await page.evaluate(() => document.querySelector('select[aria-label="Choose board object"]').value)
  let b = await bounds(graphId)
  await drag(b.x + b.width / 2, b.y + b.height / 2, 50, 30)
  await expectBounds(graphId, { x: b.x + 50, y: b.y + 30 })
  await button('Undo'); await expectBounds(graphId, { x: b.x, y: b.y })
  await button('Redo'); await expectBounds(graphId, { x: b.x + 50, y: b.y + 30 })
  report.push('Notebook creation/reload and native drag undo/redo')

  b = await bounds(graphId)
  await page.keyboard.down('Shift')
  try { await drag(b.right, b.bottom, 40, 20) } finally { await page.keyboard.up('Shift') }
  await expectBounds(graphId, { width: b.width + 40, height: b.height + 20 })
  await button('Undo'); await expectBounds(graphId, { width: b.width, height: b.height })
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
  await page.keyboard.press('ControlOrMeta+d'); await count(5)
  await page.keyboard.press('ControlOrMeta+d'); await count(6)
  await button('Undo'); await count(5); await button('Undo'); await count(4)
  report.push('Native independent resize, duplicate twice, and separate undo steps')

  await choose('Graph: sin(x)')
  await page.fill(source, 'x^2+y^2=9'); await expectSource('x^2+y^2=9')
  await page.waitForFunction(() => document.querySelector('select[aria-label="Choose board object"] option:checked')?.textContent === 'Graph: x^2+y^2=9')
  await page.fill(source, 'x^2+y^2='); await page.waitForSelector('.source-status.has-error')
  check(await page.evaluate(() => document.querySelector('select[aria-label="Choose board object"] option:checked').textContent) === 'Graph: x^2+y^2=9', 'Invalid source replaced the valid graph')
  await button('Restore last valid'); await expectSource('x^2+y^2=9')
  await button('Collapse object controls'); await page.click('.reopen-inspector')
  await button('Lock object')
  check(await page.evaluate(() => document.querySelector('textarea[aria-label="Object content"]').disabled), 'Locked graph is editable')
  await button('Unlock object')
  report.push('Implicit equation, invalid draft recovery, persistent controls and locking')

  await choose('Equation: \\int_0^{2\\pi} \\sin(x)\\,dx = 0')
  await button('Edit on board'); await page.waitForSelector('math-field')
  await button('LaTeX source')
  await page.fill('textarea[aria-label="LaTeX source"]', '\\frac{x}{2}+7')
  await button('Done'); await expectSource('\\frac{x}{2}+7')
  await button('Undo'); await expectSource('\\int_0^{2\\pi} \\sin(x)\\,dx = 0')
  await button('Redo'); await expectSource('\\frac{x}{2}+7')
  report.push('Inline equation editing keeps selection and inspector, with undo/redo')

  await button('Deselect object'); await button('Pan')
  await drag(750, 700, -300, -250)
  await button('Pencil'); await button('Ink color blue')
  await drag(220, 750, 150, 30); await count(5)
  await button('Undo'); await count(4); await button('Redo'); await count(5)
  await button('Eraser'); await drag(280, 740, 0, 60); await count(4)
  await button('Undo'); await count(5)
  report.push('Pan, colored freehand, eraser and undo/redo')

  await button('Text'); await page.mouse.click(420, 650)
  await page.waitForSelector('textarea[aria-label="Edit text"]')
  await page.fill('textarea[aria-label="Edit text"]', 'Notebook source\nSecond line remains editable.')
  await button('Done'); await count(6)
  await expectSource('Notebook source\nSecond line remains editable.')
  await page.fill(source, 'Saved immediately before switching')
  await button('Notebooks'); await page.fill('input[placeholder="New notebook name"]', `${name} other`)
  await button('Create'); await count(0)
  await button('Notebooks')
  const index = await page.evaluate(name => [...document.querySelectorAll(".notebook-list-item strong")].findIndex(element => element.textContent === name), name)
  check(index >= 0, "Original smoke notebook is missing")
  await page.click(`.notebook-list-item >> nth=${index}`)
  await count(6)
  await page.reload(); await count(6)
  const labels = await page.evaluate(() => [...document.querySelectorAll('select[aria-label="Choose board object"] option')].map(e => e.textContent))
  check(labels.includes('Text: Saved immediately before switching'), 'Pending source was not saved on notebook switch')
  check(labels.includes('Graph: x^2+y^2=9'), 'Implicit expression was lost after reload')
  check(labels.includes('Equation: \\frac{x}{2}+7'), 'Equation source was lost after reload')
  check(!await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent), 'App reports an error')
  report.push('Text creation, pending-source flush, notebook isolation and final reload')
  return { name, checks: report, objects: 6 }
}
