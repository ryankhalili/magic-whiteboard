async (page) => {
  // Run with @Browser browser_run_code_unsafe and this file's path. The current
  // page must already show MagiBoard in a desktop-sized viewport.
  // All observations below read rendered DOM; all changes use ordinary UI input.
  const report = []
  const notebookName = `Excalidraw smoke ${Date.now()}`
  const sourceText = 'Smoke test text\nSecond line stays editable.'
  const sourceMath = '\\frac{a^2}{b} + 7'
  const shapeSelector = '.whiteboard-live-shape[data-shape-id]'
  const timeout = 20_000
  const runtimeErrors = []
  const onPageError = error => runtimeErrors.push(error.message)
  page.on('pageerror', onPageError)
  let step = 'Open notebook library'

  const frames = () => page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  }))
  const check = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const passed = detail => report.push({ check: step, result: 'passed', ...(detail ? { detail } : {}) })
  const button = name => page.getByRole('button', { name, exact: true })
  const count = () => page.locator('.canvas-status').innerText().then(text => {
    const match = text.match(/(\d+)\s+objects?\b/)
    if (!match) throw new Error(`Object count is missing from the canvas footer: ${text}`)
    return Number(match[1])
  })
  const expectCount = async expected => {
    await page.waitForFunction(expectedCount => {
      const text = document.querySelector('.canvas-status')?.textContent || ''
      return Number(text.match(/(\d+)\s+objects?\b/)?.[1]) === expectedCount
    }, expected, { timeout })
    await frames()
    check(await count() === expected, `Expected ${expected} objects after the UI settled`)
  }
  const saved = async () => {
    await page.waitForFunction(() => {
      const status = document.querySelector('.document-title > span')?.textContent || ''
      return status.includes('Saved on this device') && !document.querySelector('.notebook-loading')
    }, undefined, { timeout })
  }
  const shape = id => page.locator(`${shapeSelector}[data-shape-id=${JSON.stringify(id)}]`)
  const bounds = async locator => {
    const box = await locator.boundingBox()
    check(box && box.width > 0 && box.height > 0, 'The target object has no rendered bounds')
    return box
  }
  const expectBounds = async (id, expected, tolerance = 2) => {
    await page.waitForFunction(({ selector, expectedBox, tolerance }) => {
      const box = document.querySelector(selector)?.getBoundingClientRect()
      return !!box && ['x', 'y', 'width', 'height'].every(key => Math.abs(box[key] - expectedBox[key]) <= tolerance)
    }, { selector: `${shapeSelector}[data-shape-id=${JSON.stringify(id)}]`, expectedBox: expected, tolerance }, { timeout })
    await frames()
  }
  const drag = async (start, end) => {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    try { await page.mouse.move(end.x, end.y, { steps: 12 }) }
    finally { await page.mouse.up() }
    await frames()
  }
  const focusGraph = async id => {
    await button('Select & move').click()
    const box = await bounds(shape(id))
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.locator('.object-inspector').getByText('Graph', { exact: true }).waitFor({ state: 'visible', timeout })
    await frames()
    return bounds(shape(id))
  }
  const visibleBlankArea = async (width, height, extra = []) => page.evaluate(({ width, height, extra }) => {
    const stage = document.querySelector('.board-stage')?.getBoundingClientRect()
    if (!stage) return null
    const occupied = [...document.querySelectorAll(
      '.whiteboard-live-shape,.tool-rail,.board-options,.command-dock,.canvas-footer,.object-inspector,.history-panel,.popover,.empty-board,.tool-instruction',
    )].map(element => element.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0)
      .map(box => ({ x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 }))
      .concat(extra)
    const left = Math.max(stage.left + 90, 15)
    const right = Math.min(stage.right - 20, innerWidth - 20)
    const top = Math.max(stage.top + 75, 15)
    const bottom = Math.min(stage.bottom - 70, innerHeight - 30)
    for (let y = bottom - height; y >= top; y -= 24) {
      for (let x = left; x + width <= right; x += 24) {
        if (!occupied.some(box => x < box.x + box.width && x + width > box.x && y < box.y + box.height && y + height > box.y)) {
          return { x, y, width, height }
        }
      }
    }
    return null
  }, { width, height, extra })
  const blankArea = async (width, height, extra = []) => {
    let area = await visibleBlankArea(width, height, extra)
    if (area) return area
    // Make space through the Pan tool when the example fills the viewport.
    // This also avoids placing an editor underneath an inspector or command bar.
    await button('Pan').click()
    const stage = await bounds(page.locator('.board-stage'))
    await drag(
      { x: stage.x + stage.width * .6, y: stage.y + stage.height * .55 },
      { x: stage.x + 130, y: stage.y + 120 },
    )
    area = await visibleBlankArea(width, height)
    check(area, `No ${width} × ${height} blank area is available; use a larger desktop viewport`)
    return area
  }

  try {
    const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Meta' : 'Control')
    await button('Notebooks').click()
    await page.getByRole('textbox', { name: 'New notebook name', exact: true }).fill(notebookName)
    await button('Create').click()
    await button('Try an example').waitFor({ state: 'visible', timeout })
    await expectCount(0)
    passed()

    step = 'Example and notebook rename'
    await button('Try an example').click()
    await expectCount(4)
    await page.getByRole('textbox', { name: 'Notebook title', exact: true }).fill(notebookName)
    await saved()
    const graph = page.locator(shapeSelector).filter({ hasText: 'y = sin(x)' })
    check(await graph.count() === 1, 'The example must have exactly one sine graph')
    const graphId = await graph.getAttribute('data-shape-id')
    check(graphId, 'The graph has no stable object ID')
    passed('Four editable example objects')

    step = 'Reload saved example'
    await page.reload()
    await expectCount(4)
    await saved()
    check(await page.getByRole('textbox', { name: 'Notebook title', exact: true }).inputValue() === notebookName, 'Notebook title did not survive reload')
    check(await shape(graphId).count() === 1, 'Graph identity did not survive reload')
    passed()

    step = 'Native graph drag, undo, and redo'
    const original = await focusGraph(graphId)
    await drag(
      { x: original.x + original.width / 2, y: original.y + original.height / 2 },
      { x: original.x + original.width / 2 + 70, y: original.y + original.height / 2 + 30 },
    )
    const moved = { ...original, x: original.x + 70, y: original.y + 30 }
    await expectBounds(graphId, moved)
    await button('Undo').click()
    await expectBounds(graphId, original)
    await button('Redo').click()
    await expectBounds(graphId, moved)
    await expectCount(4)
    passed('Moved 70 × 30 screen pixels')

    step = 'Native free resize and undo'
    const beforeResize = await focusGraph(graphId)
    const handle = { x: beforeResize.x + beforeResize.width, y: beforeResize.y + beforeResize.height }
    await page.keyboard.down('Shift')
    try { await drag(handle, { x: handle.x + 90, y: handle.y + 30 }) }
    finally { await page.keyboard.up('Shift') }
    await page.waitForFunction(({ selector, before }) => {
      const box = document.querySelector(selector)?.getBoundingClientRect()
      return !!box && box.width > before.width + 60 && box.height > before.height + 10
    }, { selector: `${shapeSelector}[data-shape-id=${JSON.stringify(graphId)}]`, before: beforeResize }, { timeout })
    const resized = await bounds(shape(graphId))
    check(Math.abs(resized.width / beforeResize.width - resized.height / beforeResize.height) > .03, 'Shift resize incorrectly kept the graph aspect ratio')
    await button('Undo').click()
    await expectBounds(graphId, beforeResize)
    passed('Independent width and height restored by one Undo')

    step = 'Two native duplicates have separate undo steps'
    await focusGraph(graphId)
    await page.keyboard.press(`${modifier}+d`)
    await expectCount(5)
    await page.keyboard.press(`${modifier}+d`)
    await expectCount(6)
    await page.keyboard.press(`${modifier}+z`)
    await expectCount(5)
    await page.keyboard.press(`${modifier}+z`)
    await expectCount(4)
    check(await page.locator(shapeSelector).filter({ hasText: 'y = sin(x)' }).count() === 1, 'Undo did not remove exactly the two graph copies')
    passed()

    step = 'Native pencil, eraser, and undo'
    if (await button('Deselect object').isVisible()) await button('Deselect object').click()
    const inkArea = await blankArea(120, 70)
    await button('Pencil').click()
    const stroke = [
      { x: inkArea.x + 10, y: inkArea.y + 35 },
      { x: inkArea.x + 35, y: inkArea.y + 10 },
      { x: inkArea.x + 65, y: inkArea.y + 50 },
      { x: inkArea.x + 105, y: inkArea.y + 20 },
    ]
    await page.mouse.move(stroke[0].x, stroke[0].y)
    await page.mouse.down()
    try { for (const point of stroke.slice(1)) await page.mouse.move(point.x, point.y, { steps: 6 }) }
    finally { await page.mouse.up() }
    await expectCount(5)
    await button('Eraser').click()
    await drag({ x: stroke[1].x - 8, y: stroke[1].y }, { x: stroke[1].x + 8, y: stroke[1].y })
    await expectCount(4)
    await button('Undo').click()
    await expectCount(5)
    passed('One native ink object restored')

    step = 'Direct text creation'
    const zoom = Number((await page.locator('.zoom-controls > span').innerText()).replace('%', '')) / 100
    const textArea = await blankArea(Math.ceil(400 * zoom + 40), Math.ceil(170 * zoom + 45), [inkArea])
    await button('Text').click()
    await page.mouse.click(textArea.x + 8, textArea.y + 8)
    const textEditor = page.getByRole('textbox', { name: 'Edit text', exact: true })
    await textEditor.waitFor({ state: 'visible', timeout })
    await textEditor.fill(sourceText)
    await page.locator('.marginalia-inline-editor').getByRole('button', { name: 'Done', exact: true }).click()
    await textEditor.waitFor({ state: 'hidden', timeout })
    await expectCount(6)
    const note = page.locator(shapeSelector).filter({ hasText: 'Second line stays editable.' })
    check(await note.count() === 1, 'The typed note is missing or duplicated')
    const textId = await note.getAttribute('data-shape-id')
    passed('Multiline source retained')

    step = 'Direct equation creation through LaTeX source'
    if (await button('Deselect object').isVisible()) await button('Deselect object').click()
    const mathArea = await blankArea(Math.ceil(400 * zoom + 40), Math.ceil(140 * zoom + 45))
    await button('Math').click()
    await page.mouse.click(mathArea.x + 8, mathArea.y + 8)
    const inline = page.locator('.marginalia-inline-editor')
    await inline.getByRole('button', { name: 'LaTeX source', exact: true }).click()
    const mathEditor = page.getByRole('textbox', { name: 'LaTeX source', exact: true })
    await mathEditor.fill(sourceMath)
    const mathId = await page.locator(`${shapeSelector}.is-editing`).getAttribute('data-shape-id')
    check(mathId, 'The new equation has no stable object ID')
    await inline.getByRole('button', { name: 'Done', exact: true }).click()
    await mathEditor.waitFor({ state: 'hidden', timeout })
    await expectCount(7)
    await saved()
    passed('Editable fraction saved')

    step = 'Reload all seven objects and verify editable source'
    await page.reload()
    await expectCount(7)
    await saved()
    check(await shape(graphId).count() === 1 && await shape(textId).count() === 1 && await shape(mathId).count() === 1, 'An object ID changed or disappeared after reload')
    check((await shape(textId).innerText()).includes('Second line stays editable.'), 'The note content did not survive reload')
    await button('Select & move').click()
    const equation = await bounds(shape(mathId))
    await page.mouse.click(equation.x + equation.width / 2, equation.y + equation.height / 2)
    await page.locator('.object-inspector').getByText('Equation', { exact: true }).waitFor({ state: 'visible', timeout })
    check(await page.getByRole('textbox', { name: 'Object content', exact: true }).inputValue() === sourceMath, 'Reloaded equation lost its editable LaTeX source')
    check(await page.getByRole('textbox', { name: 'Notebook title', exact: true }).inputValue() === notebookName, 'Reloaded notebook has the wrong title')
    const alerts = await page.locator('.canvas-render-error,.error-banner').allTextContents()
    check(!alerts.some(text => text.trim()), `The app reported an error: ${alerts.join(' | ')}`)
    check(runtimeErrors.length === 0, `Uncaught browser error: ${runtimeErrors.join(' | ')}`)
    await button('Deselect object').click()
    await button('Magic pen').click()
    passed('Seven objects, stable IDs, source, and saved title')
    return { notebook: notebookName, objects: await count(), report }
  } catch (error) {
    report.push({ check: step, result: 'failed', detail: error instanceof Error ? error.message : String(error) })
    const footer = await page.locator('.canvas-status').innerText().catch(() => 'Canvas footer unavailable')
    throw new Error(`Excalidraw smoke failed: ${step}\n${JSON.stringify({ notebook: notebookName, footer, report, runtimeErrors }, null, 2)}`)
  } finally {
    page.off('pageerror', onPageError)
  }
}
