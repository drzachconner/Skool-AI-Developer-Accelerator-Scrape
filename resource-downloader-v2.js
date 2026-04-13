/**
 * Skool Resource Downloader v2 - AI Developer Accelerator
 *
 * Downloads .docx/.pdf/.pages resources from Skool classroom lessons.
 * Uses api2.skool.com/files/{file_id}/download-url for CloudFront signed URLs.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config();

const CONFIG = {
  email: process.env.EMAIL,
  password: process.env.PASSWORD,
  slug: 'ai-developer-accelerator',
  baseUrl: 'https://www.skool.com',
  classroomDir: path.join(__dirname, 'scraped-content', '02-Classroom'),
  headless: process.env.HEADLESS !== 'false',
  delayMin: 800,
  delayMax: 2000
};

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 200);
}

function randomDelay() {
  return CONFIG.delayMin + Math.random() * (CONFIG.delayMax - CONFIG.delayMin);
}

function collectResources() {
  const resources = [];
  if (!fs.existsSync(CONFIG.classroomDir)) return resources;

  const coursesDirs = fs.readdirSync(CONFIG.classroomDir).filter(d =>
    fs.statSync(path.join(CONFIG.classroomDir, d)).isDirectory()
  );

  for (const courseDir of coursesDirs) {
    const indexPath = path.join(CONFIG.classroomDir, courseDir, '_lessons-index.json');
    if (!fs.existsSync(indexPath)) continue;

    let lessons;
    try { lessons = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { continue; }

    for (const lesson of lessons) {
      if (!lesson.resources) continue;

      let resList;
      try {
        resList = typeof lesson.resources === 'string' ? JSON.parse(lesson.resources) : lesson.resources;
      } catch { continue; }

      if (!Array.isArray(resList)) continue;

      for (const res of resList) {
        if (!res.file_id) continue;

        const moduleName = sanitize(lesson.parentTitle || 'General');
        const lessonName = sanitize(lesson.title || 'untitled');
        const outDir = path.join(CONFIG.classroomDir, courseDir, moduleName);

        let actualLessonDir = null;
        if (fs.existsSync(outDir)) {
          const dirs = fs.readdirSync(outDir).filter(d => {
            const stripped = d.replace(/^\d+-/, '');
            return stripped === lessonName || d === lessonName;
          });
          if (dirs.length > 0) actualLessonDir = path.join(outDir, dirs[0]);
        }
        if (!actualLessonDir) actualLessonDir = path.join(outDir, lessonName);

        const resDir = path.join(actualLessonDir, 'resources');
        const fileName = sanitize(res.file_name || res.title || `resource-${res.file_id}`);
        const filePath = path.join(resDir, fileName);

        resources.push({
          fileId: res.file_id,
          fileName,
          title: res.title || res.file_name,
          contentType: res.file_content_type,
          course: courseDir,
          lesson: lesson.title,
          filePath,
          resDir
        });
      }
    }
  }

  return resources;
}

async function main() {
  const allResources = collectResources();
  console.log(`Found ${allResources.length} resources with file_id across all courses`);

  const pending = allResources.filter(r => !fs.existsSync(r.filePath) || fs.statSync(r.filePath).size === 0);
  const skipped = allResources.length - pending.length;
  console.log(`  ${skipped} already downloaded, ${pending.length} pending\n`);

  if (pending.length === 0) {
    console.log('All resources already downloaded!');
    return;
  }

  const { chromium } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromium.use(StealthPlugin());

  console.log(`Launching browser (headless: ${CONFIG.headless})...`);
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  console.log('Logging in...');
  await page.goto('https://www.skool.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  if (page.url().includes('/login')) {
    for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="email" i]']) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) { await el.fill(CONFIG.email); break; }
      } catch {}
    }
    const pw = page.locator('input[type="password"]').first();
    await pw.waitFor({ state: 'visible', timeout: 5000 });
    await pw.fill(CONFIG.password);
    for (const sel of ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Continue")']) {
      try {
        const b = page.locator(sel).first();
        if (await b.isVisible({ timeout: 2000 })) { await b.click(); break; }
      } catch {}
    }
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    if (page.url().includes('/login')) throw new Error('Login failed!');
    console.log('Login successful!');
  } else {
    console.log('Already logged in!');
  }

  await page.goto(`${CONFIG.baseUrl}/${CONFIG.slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const cookies = await context.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  let downloaded = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < pending.length; i++) {
    const res = pending[i];
    console.log(`[${i + 1}/${pending.length}] ${res.course} > ${res.lesson}`);
    console.log(`  File: ${res.fileName} (${res.fileId})`);

    try {
      const apiUrl = `https://api2.skool.com/files/${res.fileId}/download-url?expire=28800`;
      const apiResponse = await page.request.post(apiUrl, {
        headers: {
          'Content-Type': 'application/json',
          'Origin': CONFIG.baseUrl,
          'Referer': `${CONFIG.baseUrl}/${CONFIG.slug}/classroom`,
          'Cookie': cookieStr
        },
        timeout: 30000
      });

      if (!apiResponse.ok()) {
        const errText = await apiResponse.text().catch(() => '');
        throw new Error(`API ${apiResponse.status()}: ${errText.substring(0, 200)}`);
      }

      let signedUrl;
      const responseText = await apiResponse.text();

      try {
        const json = JSON.parse(responseText);
        signedUrl = json.url || json.downloadUrl || json.signedUrl || json.data?.url || json.data?.downloadUrl;
        if (!signedUrl) {
          const urlMatch = JSON.stringify(json).match(/https?:\/\/files\.skool\.com[^"\\]*/);
          if (urlMatch) signedUrl = urlMatch[0];
          else throw new Error('No URL found in API response');
        }
      } catch (parseErr) {
        if (responseText.startsWith('http')) signedUrl = responseText.trim();
        else throw new Error(`Cannot parse API response: ${parseErr.message}`);
      }

      console.log(`  Signed URL: ${signedUrl.substring(0, 100)}...`);

      fs.mkdirSync(res.resDir, { recursive: true });

      const fileResponse = await page.request.get(signedUrl, { timeout: 60000 });
      if (!fileResponse.ok()) throw new Error(`Download failed: HTTP ${fileResponse.status()}`);

      const buf = await fileResponse.body();
      if (buf.length === 0) throw new Error('Empty file body');

      fs.writeFileSync(res.filePath, buf);
      downloaded++;
      console.log(`  OK (${buf.length} bytes) -> ${res.filePath}`);

    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
      failed++;
      failures.push({ fileId: res.fileId, fileName: res.fileName, course: res.course, lesson: res.lesson, error: e.message });
    }

    await new Promise(r => setTimeout(r, randomDelay()));
  }

  console.log(`\n=== Resource Download Complete ===`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Skipped (existing): ${skipped}`);
  console.log(`Failed: ${failed}`);

  if (failures.length > 0) {
    console.log(`\nFailed downloads:`);
    for (const f of failures) console.log(`  ${f.fileName} (${f.course} > ${f.lesson}): ${f.error}`);
  }

  const report = { timestamp: new Date().toISOString(), total: allResources.length, downloaded, skipped, failed, failures };
  fs.writeFileSync(path.join(CONFIG.classroomDir, '_resource-download-report.json'), JSON.stringify(report, null, 2));

  await browser.close();
  console.log('\nDone!');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
