---
name: playwright
description: Use Playwright for browser automation in this workspace. Install locally and run scripts as needed.
---

# Playwright

Use Playwright for browser automation and web scraping.

## Steps

1. Ensure the project has a `package.json` (create if missing):
   ```bash
   bun init -y
   ```

2. Install Playwright locally (per-project):
   ```bash
   bun add -d playwright
   ```

3. Install the browsers and OS deps (recommended in this container):
   ```bash
   bunx playwright install --with-deps
   # or just chromium if you want lighter installs
   bunx playwright install chromium --with-deps
   ```

4. Create a script (example):
   ```ts
   import { chromium } from "playwright";

   const browser = await chromium.launch({ headless: true });
   const page = await browser.newPage();
   await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
   const title = await page.title();
   console.log(title);
   await browser.close();
   ```

5. Run the script with Bun:
   ```bash
   bun run scripts/playwright/example.ts
   ```

## Tips

- For debugging, run with `headless: false` and add `slowMo: 50`.
- If Playwright complains about missing dependencies, re-run:
  ```bash
  bunx playwright install --with-deps
  ```
- To keep browser binaries in the workspace, set:
  ```bash
  export PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright
  ```
