import { chromium } from 'playwright';
import fs from 'node:fs';

const context = await chromium.launchPersistentContext('runtime/browser-profile', {
  headless: false,
});

const page = context.pages()[0] ?? await context.newPage();
await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const state = await context.storageState();
fs.writeFileSync('runtime/storage-state.json', JSON.stringify(state, null, 2));

console.log('saved runtime/storage-state.json');
await context.close();
