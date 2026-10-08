import { chromium } from '@playwright/test';
const b = await chromium.launch();
// Does the gutter also swallow a plain layer selection (no insert armed)?
for (const x of [40, 55, 66, 67, 70]) {
  const p = await b.newPage({ viewport: { width: 1024, height: 768 } });
  await p.goto('http://localhost:5173/#/geologie');
  await p.waitForTimeout(1800);
  await p.mouse.click(x, 300);
  await p.waitForTimeout(300);
  const z = await p.evaluate(() => document.body.innerText.includes('Bodenart ändern')
    ? 'selects a layer' : 'nothing happens');
  console.log(`plain tap (${String(x).padStart(2)},300) -> ${z}`);
  await p.close();
}
await b.close();
