/**
 * Skool Community Scraper - AI Developer Accelerator
 *
 * Adapted from Agent Architects scraper.
 * Uses __NEXT_DATA__ JSON extraction from Skool's Next.js SSR pages.
 * Scrapes: Classroom courses/modules/lessons, Community posts, About page
 * Auth: Email + Password via Playwright browser automation
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const LOG_FILE = path.join(__dirname, 'scraper.log');
fs.writeFileSync(LOG_FILE, `--- Run started ${new Date().toISOString()} ---\n`);
const _log = console.log;
const _err = console.error;
console.log = (...args) => { _log(...args); try { fs.appendFileSync(LOG_FILE, args.join(' ') + '\n'); } catch {} };
console.error = (...args) => { _err(...args); try { fs.appendFileSync(LOG_FILE, '[ERR] ' + args.join(' ') + '\n'); } catch {} };
process.on('uncaughtException', (err) => { try { fs.appendFileSync(LOG_FILE, `[FATAL] ${err.message}\n${err.stack}\n`); } catch {} process.exit(1); });
process.on('unhandledRejection', (err) => { try { fs.appendFileSync(LOG_FILE, `[FATAL] Unhandled: ${err}\n`); } catch {} });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG = {
  email: process.env.EMAIL,
  password: process.env.PASSWORD,
  slug: 'ai-developer-accelerator',
  groupId: null, // Will be discovered from __NEXT_DATA__
  baseUrl: 'https://www.skool.com',
  downloadDir: path.join(__dirname, 'scraped-content'),
  progressFile: path.join(__dirname, 'scraped-content', 'progress.json'),
  headless: process.env.HEADLESS !== 'false',
  timeout: 90000,
  delayMin: 1500,
  delayMax: 3500
};

const FORCE_LESSONS = process.argv.includes('--force-lessons');
const FORCE_POSTS = process.argv.includes('--force-posts');

if (!CONFIG.email || !CONFIG.password) { console.error('Set EMAIL and PASSWORD in .env'); process.exit(1); }

const url = (p) => `${CONFIG.baseUrl}/${CONFIG.slug}${p}`;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 200);
}
function randomDelay() { return CONFIG.delayMin + Math.random() * (CONFIG.delayMax - CONFIG.delayMin); }

// ---------------------------------------------------------------------------
// Scraper
// ---------------------------------------------------------------------------
class SkoolScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.progress = { posts: [], lessons: [] };
    this.stats = { posts: 0, lessons: 0, files: 0, skipped: 0, errors: 0 };
    this.failed = [];
  }

  async init() {
    const { chromium } = require('playwright-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    chromium.use(StealthPlugin());
    console.log(`Launching browser (headless: ${CONFIG.headless})...`);
    this.browser = await chromium.launch({ headless: CONFIG.headless, args: ['--disable-blink-features=AutomationControlled'] });
    const ctx = await this.browser.newContext({
      acceptDownloads: true, viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    this.page = await ctx.newPage();
    this.page.setDefaultTimeout(CONFIG.timeout);
    fs.mkdirSync(CONFIG.downloadDir, { recursive: true });
    if (fs.existsSync(CONFIG.progressFile)) {
      try { this.progress = JSON.parse(fs.readFileSync(CONFIG.progressFile, 'utf8')); } catch {}
    }
    console.log(`Resume: ${this.progress.posts.length} posts, ${this.progress.lessons.length} lessons done`);
  }

  saveProgress() { fs.writeFileSync(CONFIG.progressFile, JSON.stringify(this.progress, null, 2)); }

  async goto(u, retries = 3) {
    for (let i = 1; i <= retries; i++) {
      try {
        await this.page.goto(u, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
        await this.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        return;
      } catch (e) {
        if (i === retries || !/ERR_|TIMEOUT|net::/i.test(e.message)) throw e;
        await new Promise(r => setTimeout(r, i * 5000));
      }
    }
  }

  async getNextData() {
    return this.page.evaluate(() => {
      const el = document.querySelector('script#__NEXT_DATA__');
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch { return null; }
    });
  }

  // -----------------------------------------------------------------------
  // Login
  // -----------------------------------------------------------------------
  async login() {
    console.log('\n=== Logging into Skool ===\n');
    await this.goto('https://www.skool.com/login');
    await this.page.waitForTimeout(2000);
    const dbg = path.join(CONFIG.downloadDir, '_debug');
    fs.mkdirSync(dbg, { recursive: true });
    await this.page.screenshot({ path: path.join(dbg, '01-login.png'), fullPage: true });
    if (!this.page.url().includes('/login')) { console.log('Already logged in!'); return; }

    for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="email" i]']) {
      try { const el = this.page.locator(sel).first(); if (await el.isVisible({ timeout: 3000 })) { await el.fill(CONFIG.email); break; } } catch {}
    }
    const pw = this.page.locator('input[type="password"]').first();
    await pw.waitFor({ state: 'visible', timeout: 5000 });
    await pw.fill(CONFIG.password);
    for (const sel of ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Continue")']) {
      try { const b = this.page.locator(sel).first(); if (await b.isVisible({ timeout: 2000 })) { await b.click(); break; } } catch {}
    }
    await this.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await this.page.waitForTimeout(3000);
    await this.page.screenshot({ path: path.join(dbg, '02-after-login.png'), fullPage: true });
    if (this.page.url().includes('/login')) throw new Error('Login failed');
    console.log('Login successful!');
  }

  // -----------------------------------------------------------------------
  // Content extraction
  // -----------------------------------------------------------------------
  async extractContent() {
    return this.page.evaluate(() => {
      const main = document.querySelector('[class*="styled__Content"], [class*="styled__Body"], article, main') || document.body;
      const lines = [], links = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType === 3) { const t = c.textContent.trim(); if (t) lines.push(t); }
          else if (c.nodeType === 1) {
            const tag = c.tagName.toLowerCase();
            if (['script','style','nav','footer','header','svg'].includes(tag)) continue;
            if (tag === 'a') { const h = c.getAttribute('href'), t = c.textContent.trim(); if (h && t) { links.push({ text: t, url: h.startsWith('http') ? h : location.origin + h }); lines.push(`[${t}](${h.startsWith('http') ? h : location.origin + h})`); } return; }
            if (tag === 'img') { const s = c.getAttribute('src'), a = c.getAttribute('alt') || ''; if (s && !s.includes('avatar')) lines.push(`![${a}](${s})`); return; }
            if (/^h[1-6]$/.test(tag)) { lines.push('', '#'.repeat(+tag[1]) + ' ' + c.textContent.trim(), ''); return; }
            if (tag === 'li') { lines.push('- ' + c.textContent.trim()); return; }
            if (tag === 'pre' || tag === 'code') { lines.push('```', c.textContent.trim(), '```'); return; }
            if (tag === 'br') { lines.push(''); return; }
            walk(c); if (tag === 'p' || tag === 'div') lines.push('');
          }
        }
      };
      const h1 = document.querySelector('h1'); if (h1) lines.push('# ' + h1.textContent.trim(), '');
      walk(main);
      return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), links };
    });
  }

  async savePage(dir, pageUrl) {
    fs.mkdirSync(dir, { recursive: true });
    const content = await this.extractContent();
    fs.writeFileSync(path.join(dir, 'page.html'), await this.page.content());
    if (content.text) fs.writeFileSync(path.join(dir, 'content.md'), `---\nurl: ${pageUrl}\nscraped: ${new Date().toISOString()}\n---\n\n${content.text}`);
    if (content.links.length) fs.writeFileSync(path.join(dir, 'links.md'), content.links.map(l => `- [${l.text}](${l.url})`).join('\n'));
    await this.page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true }).catch(() => {});
    return content;
  }

  async downloadFileViaNavigation(fileUrl, filePath) {
    let dlPage = null;
    try {
      const ctx = this.page.context();
      dlPage = await ctx.newPage();
      let downloadTriggered = false;
      let downloadObj = null;
      dlPage.on('download', (dl) => { downloadTriggered = true; downloadObj = dl; });
      const response = await dlPage.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await dlPage.waitForTimeout(1000);
      if (downloadTriggered && downloadObj) {
        await downloadObj.saveAs(filePath);
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return true;
      }
      if (response && response.ok()) {
        const buf = await response.body();
        if (buf.length > 0) { fs.writeFileSync(filePath, buf); return true; }
      }
      const finalUrl = dlPage.url();
      if (finalUrl !== fileUrl && !finalUrl.includes('skool.com/login')) {
        const axios = require('axios');
        const resp = await axios.get(finalUrl, { responseType: 'arraybuffer', timeout: 60000 });
        if (resp.data && resp.data.length > 0) { fs.writeFileSync(filePath, resp.data); return true; }
      }
      return false;
    } catch (e) {
      console.log(`      Navigation download failed: ${e.message}`);
      return false;
    } finally {
      if (dlPage) await dlPage.close().catch(() => {});
    }
  }

  async downloadFile(fileUrl, filePath) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) { this.stats.skipped++; return; }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fileUrl.includes('assets.skool.com')) {
      const success = await this.downloadFileViaNavigation(fileUrl, filePath);
      if (success) { this.stats.files++; return; }
    }

    // Strategy 1: axios
    try {
      const cookies = await this.page.context().cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const axios = require('axios');
      const resp = await axios.get(fileUrl, {
        responseType: 'stream', timeout: 120000, maxRedirects: 5,
        headers: {
          Cookie: cookieStr, Referer: 'https://www.skool.com/', Origin: 'https://www.skool.com',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
      });
      const w = fs.createWriteStream(filePath);
      resp.data.pipe(w);
      await new Promise((res, rej) => { w.on('finish', res); w.on('error', rej); });
      if (fs.statSync(filePath).size > 0) { this.stats.files++; return; }
      fs.unlinkSync(filePath);
    } catch (e) {
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }

    // Strategy 2: Playwright page.request
    try {
      const response = await this.page.request.get(fileUrl, {
        headers: { Referer: 'https://www.skool.com/', Origin: 'https://www.skool.com' },
        timeout: 120000
      });
      if (response.ok()) {
        const buf = await response.body();
        if (buf.length > 0) { fs.writeFileSync(filePath, buf); this.stats.files++; return; }
      }
    } catch (e) {}

    // Strategy 3: In-browser fetch
    try {
      const result = await this.page.evaluate(async (url) => {
        try {
          const resp = await fetch(url, { credentials: 'include', mode: 'cors' });
          if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
          const buf = await resp.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
          return { ok: true, data: btoa(binary) };
        } catch (e) { return { ok: false, error: e.message }; }
      }, fileUrl);
      if (result.ok && result.data) {
        const buf = Buffer.from(result.data, 'base64');
        if (buf.length > 0) { fs.writeFileSync(filePath, buf); this.stats.files++; return; }
      }
      throw new Error(result.error || 'Empty response');
    } catch (e) {
      this.failed.push({ url: fileUrl, path: filePath, error: `All strategies failed. Last: ${e.message}` });
      this.stats.errors++;
    }
  }

  async downloadPageAssets(dir) {
    const fileLinks = await this.page.evaluate(() => {
      const r = [];
      document.querySelectorAll('a[href$=".pdf"], a[href$=".doc"], a[href$=".docx"], a[href$=".md"], a[href$=".txt"], a[href$=".csv"], a[href$=".xlsx"], a[href$=".zip"], a[download]').forEach(a => {
        const h = a.getAttribute('href'); if (h && !h.startsWith('javascript:')) r.push({ url: h.startsWith('http') ? h : location.origin + h, text: a.textContent.trim() || 'file' });
      });
      return r;
    });
    for (const f of fileLinks) {
      if (f.url.includes('drive.google.com') || f.url.includes('docs.google.com')) {
        fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'files', sanitize(f.text) + '.url'), `[InternetShortcut]\nURL=${f.url}\n`);
        continue;
      }
      try { const ext = path.extname(new URL(f.url).pathname) || '.download'; await this.downloadFile(f.url, path.join(dir, 'files', sanitize(f.text).substring(0, 100) + ext)); } catch {}
    }
    const videos = await this.page.evaluate(() => {
      const r = [];
      document.querySelectorAll('video source, video[src]').forEach(v => { const s = v.getAttribute('src') || v.parentElement?.getAttribute('src'); if (s && !s.includes('.m3u8') && !s.startsWith('blob:')) r.push({ type: 'direct', url: s }); });
      document.querySelectorAll('iframe[src]').forEach(f => { const s = f.getAttribute('src'); if (s && /youtube|youtu\.be|vimeo|loom|wistia/.test(s)) r.push({ type: 'embed', url: s }); });
      return r;
    });
    if (videos.length) {
      const vdir = path.join(dir, 'videos');
      fs.mkdirSync(vdir, { recursive: true });
      fs.writeFileSync(path.join(vdir, 'index.json'), JSON.stringify(videos, null, 2));
      for (let i = 0; i < videos.length; i++) {
        if (videos[i].type === 'embed') fs.writeFileSync(path.join(vdir, `video-${i + 1}.url`), `[InternetShortcut]\nURL=${videos[i].url}\n`);
        else { try { await this.downloadFile(videos[i].url, path.join(vdir, `video-${i + 1}.mp4`)); } catch {} }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Classroom
  // -----------------------------------------------------------------------
  async isErrorPage() {
    return this.page.evaluate(() => {
      const title = document.title || '';
      const body = document.body?.textContent || '';
      return title.includes('Oops') || body.includes('something went wrong') || body.includes('page not found');
    });
  }

  async navigateToLessonViaSidebar(courseSlug, lesson, needsNavToCourse) {
    if (needsNavToCourse) {
      const courseUrl = url(`/classroom/${courseSlug}`);
      await this.goto(courseUrl);
      await this.page.waitForTimeout(3000);
      try {
        await this.page.waitForSelector('[class*="CourseMenuWrapper"], [class*="MenuItemsWrapper"]', { timeout: 15000 });
      } catch {
        console.log('      Sidebar menu not found');
        return false;
      }
    }

    try {
      const lessonSelector = `a[href*="md=${lesson.id}"]`;
      let visible = await this.page.locator(lessonSelector).first().isVisible({ timeout: 2000 }).catch(() => false);

      if (!visible && lesson.parentTitle) {
        console.log(`      Expanding module: ${lesson.parentTitle.substring(0, 40)}`);

        const markedHeader = await this.page.evaluate(({ lessonId, parentTitle }) => {
          const prev = document.querySelector('[data-scraper-target]');
          if (prev) prev.removeAttribute('data-scraper-target');
          const lessonLink = document.querySelector(`a[href*="md=${lessonId}"]`);
          if (!lessonLink) return false;
          let el = lessonLink.parentElement;
          while (el) {
            const className = el.className || '';
            if (className.includes('MenuItemWrapper') || className.includes('MenuItemsWrapper')) {
              const parentWrapper = el.parentElement;
              if (parentWrapper) {
                const titleEls = parentWrapper.querySelectorAll('[class*="MenuItemTitleWrapper"], [class*="MenuItemTitle"]');
                for (const titleEl of titleEls) {
                  const text = titleEl.textContent?.trim() || '';
                  if (text === parentTitle || text.includes(parentTitle)) {
                    titleEl.setAttribute('data-scraper-target', 'expand');
                    return true;
                  }
                }
                const pwText = parentWrapper.textContent?.trim()?.split('\n')[0] || '';
                if (pwText === parentTitle || pwText.includes(parentTitle)) {
                  parentWrapper.setAttribute('data-scraper-target', 'expand');
                  return true;
                }
              }
            }
            el = el.parentElement;
          }
          return false;
        }, { lessonId: lesson.id, parentTitle: lesson.parentTitle });

        if (markedHeader) {
          const target = this.page.locator('[data-scraper-target="expand"]').first();
          if (await target.isVisible({ timeout: 3000 }).catch(() => false)) {
            await target.click();
            await this.page.waitForTimeout(1500);
          } else {
            await this.page.evaluate(() => {
              const el = document.querySelector('[data-scraper-target="expand"]');
              if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
            });
            await this.page.waitForTimeout(500);
            await target.click().catch(() => {});
            await this.page.waitForTimeout(1500);
          }
          await this.page.evaluate(() => {
            const el = document.querySelector('[data-scraper-target]');
            if (el) el.removeAttribute('data-scraper-target');
          });
        } else {
          const titleWords = lesson.parentTitle.split(':').pop().trim();
          const exactMatch = this.page.locator(`[class*="MenuItemWrapper"]`).filter({ hasText: new RegExp(`^\\s*${titleWords.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first();
          if (await exactMatch.isVisible({ timeout: 2000 }).catch(() => false)) {
            await exactMatch.click();
            await this.page.waitForTimeout(1500);
          } else {
            const moduleRow = this.page.locator(`[class*="MenuItemWrapper"]:has-text("${titleWords}")`).first();
            if (await moduleRow.isVisible({ timeout: 2000 }).catch(() => false)) {
              await moduleRow.click();
              await this.page.waitForTimeout(1500);
            } else {
              try {
                await this.page.getByText(lesson.parentTitle, { exact: true }).first().click();
                await this.page.waitForTimeout(1500);
              } catch {
                console.log(`      Could not find module "${lesson.parentTitle}" to expand`);
              }
            }
          }
        }

        visible = await this.page.locator(lessonSelector).first().isVisible({ timeout: 3000 }).catch(() => false);
      }

      if (!visible) {
        const found = await this.page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) { el.scrollIntoView({ behavior: 'instant', block: 'center' }); return true; }
          return false;
        }, lessonSelector);
        if (found) {
          await this.page.waitForTimeout(500);
          visible = await this.page.locator(lessonSelector).first().isVisible({ timeout: 2000 }).catch(() => false);
        }
      }

      if (!visible) {
        console.log(`      Lesson link not visible after expanding module`);
        return false;
      }

      await this.page.locator(lessonSelector).first().click();
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await this.page.waitForTimeout(2000);

      if (await this.isErrorPage()) {
        console.log('      Error page detected after sidebar click');
        return false;
      }

      return true;
    } catch (e) {
      console.log(`      Sidebar click failed: ${e.message}`);
      return false;
    }
  }

  async scrapeClassroom() {
    console.log('\n=== Scraping Classroom ===\n');
    const classDir = path.join(CONFIG.downloadDir, '02-Classroom');
    fs.mkdirSync(classDir, { recursive: true });

    await this.goto(url('/classroom'));
    await this.page.waitForTimeout(3000);
    await this.page.screenshot({ path: path.join(classDir, '00-overview.png'), fullPage: true });

    const nd = await this.getNextData();
    if (!nd?.props?.pageProps) { console.error('No __NEXT_DATA__ on classroom page'); return; }
    const pp = nd.props.pageProps;
    fs.writeFileSync(path.join(classDir, '_pageProps.json'), JSON.stringify(pp, null, 2));

    // Discover groupId from __NEXT_DATA__
    if (!CONFIG.groupId && pp.group?.id) {
      CONFIG.groupId = pp.group.id;
      console.log(`  Discovered groupId: ${CONFIG.groupId}`);
    }

    const allCourses = pp.allCourses || [];
    console.log(`  ${allCourses.length} courses found`);

    for (let ci = 0; ci < allCourses.length; ci++) {
      const c = allCourses[ci];
      const courseId = c.id;
      const courseSlug = c.name;
      const courseTitle = c.metadata?.title || courseSlug || courseId.substring(0, 8);
      const numModules = c.metadata?.numModules || 0;
      const courseDirName = sanitize(`${String(ci + 1).padStart(2, '0')}-${courseTitle}`);
      const courseDir = path.join(classDir, courseDirName);
      fs.mkdirSync(courseDir, { recursive: true });

      console.log(`\n  Course ${ci + 1}/${allCourses.length}: ${courseTitle} (slug: ${courseSlug}, ${numModules} modules)`);
      fs.writeFileSync(path.join(courseDir, '_course-meta.json'), JSON.stringify(c, null, 2));

      const courseUrl = url(`/classroom/${courseSlug}`);
      try {
        await this.goto(courseUrl);
        await this.page.waitForTimeout(3000);
      } catch (e) {
        console.error(`  Failed to load course page: ${e.message}`);
        continue;
      }

      const cnd = await this.getNextData();
      if (!cnd?.props?.pageProps?.course) {
        console.log('  No course data in __NEXT_DATA__, saving page content only');
        await this.savePage(courseDir, courseUrl);
        continue;
      }

      // Also try to discover groupId here
      if (!CONFIG.groupId && cnd.props.pageProps.group?.id) {
        CONFIG.groupId = cnd.props.pageProps.group.id;
        console.log(`  Discovered groupId: ${CONFIG.groupId}`);
      }

      const courseData = cnd.props.pageProps.course;
      fs.writeFileSync(path.join(courseDir, '_course-tree.json'), JSON.stringify(courseData, null, 2));

      const lessons = [];
      const flatten = (node, parentTitle = '') => {
        if (!node) return;
        const item = node.course || node;
        const title = item.metadata?.title || item.name || '';
        const type = item.unitType;

        if (type === 'module') {
          lessons.push({
            id: item.id,
            title: title,
            parentTitle: parentTitle,
            resources: item.metadata?.resources || null,
            videoId: item.metadata?.videoId || null,
            url: `${CONFIG.baseUrl}/${CONFIG.slug}/classroom/${courseSlug}?md=${item.id}`
          });
        }

        if (node.children && Array.isArray(node.children)) {
          for (const child of node.children) {
            flatten(child, type === 'set' ? title : parentTitle);
          }
        }
      };

      flatten(courseData);
      const newLessons = lessons.filter(l => !this.progress.lessons.includes(`sidebar:${courseId}:${l.id}`));
      console.log(`  Found ${lessons.length} lessons in course tree (${newLessons.length} NEW)`);
      fs.writeFileSync(path.join(courseDir, '_lessons-index.json'), JSON.stringify(lessons, null, 2));

      let needsNavToCourse = false;

      for (let li = 0; li < lessons.length; li++) {
        const lesson = lessons[li];
        const lessonKey = `sidebar:${courseId}:${lesson.id}`;

        if (!FORCE_LESSONS && this.progress.lessons.includes(lessonKey)) {
          console.log(`    [${li + 1}/${lessons.length}] Skip: ${lesson.title.substring(0, 55)}`);
          this.stats.skipped++;
          continue;
        }

        console.log(`    [${li + 1}/${lessons.length}] ${lesson.title.substring(0, 60)}`);

        try {
          const clicked = await this.navigateToLessonViaSidebar(courseSlug, lesson, needsNavToCourse);
          if (!clicked) {
            console.log('      Retrying with fresh course page navigation...');
            const retryClicked = await this.navigateToLessonViaSidebar(courseSlug, lesson, true);
            if (!retryClicked) throw new Error('Sidebar navigation failed after retry');
          }
          needsNavToCourse = false;

          const groupName = lesson.parentTitle ? sanitize(lesson.parentTitle).substring(0, 60) : 'General';
          const lessonName = sanitize(`${String(li + 1).padStart(2, '0')}-${lesson.title}`).substring(0, 100);
          const lessonDir = path.join(courseDir, groupName, lessonName);

          const lnd = await this.getNextData();
          if (lnd?.props?.pageProps) {
            fs.mkdirSync(lessonDir, { recursive: true });
            fs.writeFileSync(path.join(lessonDir, '_nextdata.json'), JSON.stringify(lnd.props.pageProps, null, 2));
            const modData = lnd.props.pageProps.selectedModule;
            if (modData) fs.writeFileSync(path.join(lessonDir, '_module-data.json'), JSON.stringify(modData, null, 2));
          }

          if (await this.isErrorPage()) throw new Error('Error page detected');

          await this.savePage(lessonDir, lesson.url);
          await this.downloadPageAssets(lessonDir);

          if (lesson.resources) {
            try {
              const resources = typeof lesson.resources === 'string' ? JSON.parse(lesson.resources) : lesson.resources;
              if (Array.isArray(resources)) {
                const resDir = path.join(lessonDir, 'resources');
                fs.mkdirSync(resDir, { recursive: true });
                for (const res of resources) {
                  if (res.file_id) {
                    const gid = CONFIG.groupId || 'unknown';
                    const resUrl = `https://assets.skool.com/f/${gid}/${res.file_id}`;
                    const fname = sanitize(res.file_name || res.title || `resource-${res.file_id}`);
                    console.log(`      Resource: ${fname}`);
                    await this.downloadFile(resUrl, path.join(resDir, fname));
                  }
                }
              }
            } catch (e) { console.log(`      Resource parse error: ${e.message}`); }
          }

          this.progress.lessons.push(lessonKey);
          this.saveProgress();
          this.stats.lessons++;
          await this.page.waitForTimeout(randomDelay());
        } catch (e) {
          console.error(`    Error: ${e.message}`);
          this.stats.errors++;
          this.failed.push({ url: lesson.url, error: e.message });
          needsNavToCourse = true;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Community Posts
  // -----------------------------------------------------------------------
  async scrapeCommunityPosts() {
    console.log('\n=== Scraping Community Posts ===\n');
    const postsDir = path.join(CONFIG.downloadDir, '01-Community-Posts');
    fs.mkdirSync(postsDir, { recursive: true });

    await this.goto(url(''));
    await this.page.waitForTimeout(3000);

    const nd = await this.getNextData();
    if (!nd?.props?.pageProps) { console.error('No __NEXT_DATA__ on community page'); return; }
    fs.writeFileSync(path.join(postsDir, '_pageProps-keys.json'), JSON.stringify(Object.keys(nd.props.pageProps), null, 2));
    const { renderData, ...lightPageProps } = nd.props.pageProps;
    fs.writeFileSync(path.join(postsDir, '_pageProps-feed.json'), JSON.stringify(lightPageProps, null, 2));

    // Discover groupId from community page
    if (!CONFIG.groupId && nd.props.pageProps.group?.id) {
      CONFIG.groupId = nd.props.pageProps.group.id;
      console.log(`  Discovered groupId: ${CONFIG.groupId}`);
    }

    console.log('  Collecting posts via API pagination...');
    let allPostUrls = new Set();

    const collectLinks = async () => {
      return this.page.evaluate((slug) => {
        const links = [];
        document.querySelectorAll('a[href]').forEach(a => {
          const h = a.getAttribute('href') || '';
          if (h.includes('/' + slug + '/') &&
              !h.includes('/classroom') && !h.includes('/about') &&
              !h.includes('/calendar') && !h.includes('/members') &&
              !h.includes('/leaderboards') && !h.includes('/settings') &&
              h !== '/' + slug && h !== '/' + slug + '/') {
            const fullUrl = h.startsWith('http') ? h : window.location.origin + h;
            try {
              const parsed = new URL(fullUrl);
              parsed.search = '';
              links.push(parsed.href);
            } catch { links.push(fullUrl); }
          }
        });
        return links;
      }, CONFIG.slug);
    };

    const pp = nd.props.pageProps;
    const totalPosts = pp.total || 0;
    const postTrees = pp.postTrees || [];
    console.log(`  Page 1: ${postTrees.length} posts in postTrees, total reported: ${totalPosts}`);

    const extractPostUrls = (trees) => {
      const urls = [];
      for (const tree of trees) {
        const post = tree.post || tree;
        const name = post.postName || post.name || post.slug || '';
        if (name) urls.push(`${CONFIG.baseUrl}/${CONFIG.slug}/${name}`);
      }
      return urls;
    };

    for (const u of extractPostUrls(postTrees)) allPostUrls.add(u);
    const page1Links = await collectLinks();
    for (const l of page1Links) allPostUrls.add(l);
    console.log(`  After page 1: ${allPostUrls.size} unique URLs`);

    if (totalPosts > postTrees.length) {
      const postsPerPage = postTrees.length || 20;
      const totalPages = Math.ceil(totalPosts / postsPerPage);
      console.log(`  Paginating: ${totalPages} pages estimated (${totalPosts} total posts, ${postsPerPage}/page)`);

      for (let page = 2; page <= totalPages + 1 && page <= 100; page++) {
        try {
          await this.goto(url(`?p=${page}`));
          await this.page.waitForTimeout(2000 + Math.random() * 1000);
          const pageNd = await this.getNextData();
          const pageTrees = pageNd?.props?.pageProps?.postTrees || [];
          if (pageTrees.length === 0) {
            console.log(`  Page ${page}: empty -- stopping pagination`);
            break;
          }
          for (const u of extractPostUrls(pageTrees)) allPostUrls.add(u);
          const pageLinks = await collectLinks();
          for (const l of pageLinks) allPostUrls.add(l);
          console.log(`  Page ${page}: +${pageTrees.length} from API, ${allPostUrls.size} total unique`);
        } catch (e) {
          console.log(`  Page ${page}: error (${e.message}) -- stopping pagination`);
          break;
        }
      }
    }

    // Scroll fallback (skip if browser is dead)
    console.log('  Scroll fallback to catch remaining posts...');
    try {
      let prevCount = allPostUrls.size;
      let staleRounds = 0;
      for (let round = 0; round < 50 && staleRounds < 5; round++) {
        const links = await collectLinks();
        for (const l of links) allPostUrls.add(l);
        if (allPostUrls.size === prevCount) staleRounds++;
        else { staleRounds = 0; prevCount = allPostUrls.size; }
        await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await this.page.waitForTimeout(2000 + Math.random() * 1000);
      }
    } catch (e) {
      console.log(`  Scroll fallback failed (${e.message}) — continuing with ${allPostUrls.size} URLs from pagination`);
    }
    console.log(`  After scroll: ${allPostUrls.size} total unique URLs`);

    const postUrls = [...allPostUrls].filter(u => {
      const p = new URL(u).pathname;
      const parts = p.split('/').filter(Boolean);
      return parts.length === 2 && parts[0] === CONFIG.slug;
    });

    const normalizedExisting = new Set(
      this.progress.posts.map(u => { try { const p = new URL(u); p.search = ''; return p.href; } catch { return u; } })
    );
    const newPosts = postUrls.filter(u => !normalizedExisting.has(u));
    console.log(`  Collected ${postUrls.length} unique post URLs`);
    console.log(`  NEW posts to scrape: ${newPosts.length} | Already done: ${postUrls.length - newPosts.length}`);
    fs.writeFileSync(path.join(postsDir, '_post-urls.json'), JSON.stringify(postUrls, null, 2));

    const normalizedPostProgress = new Set(
      this.progress.posts.map(u => { try { const p = new URL(u); p.search = ''; return p.href; } catch { return u; } })
    );

    for (let i = 0; i < postUrls.length; i++) {
      const postUrl = postUrls[i];
      if (!FORCE_POSTS && normalizedPostProgress.has(postUrl)) { this.stats.skipped++; continue; }

      try {
        await this.goto(postUrl);
        await this.page.waitForTimeout(1500);

        const title = await this.page.evaluate(() => {
          const h1 = document.querySelector('h1');
          return h1 ? h1.textContent.trim() : document.title.split(' · ')[0].trim();
        });

        console.log(`  [${i + 1}/${postUrls.length}] ${title.substring(0, 65)}`);

        const postDirName = sanitize(`${String(i + 1).padStart(3, '0')}-${title.substring(0, 80)}`);
        const postDir = path.join(postsDir, postDirName);

        const pnd = await this.getNextData();
        if (pnd?.props?.pageProps) {
          fs.mkdirSync(postDir, { recursive: true });
          fs.writeFileSync(path.join(postDir, '_nextdata.json'), JSON.stringify(pnd.props.pageProps, null, 2));
        }

        await this.savePage(postDir, postUrl);
        await this.downloadPageAssets(postDir);
        await this.scrapeComments(postDir);

        this.progress.posts.push(postUrl);
        this.saveProgress();
        this.stats.posts++;
        await this.page.waitForTimeout(randomDelay());
      } catch (e) {
        console.error(`  Error: ${e.message}`);
        this.stats.errors++;
        // If browser is dead, stop scraping instead of cascading failures
        if (e.message.includes('Target page, context or browser has been closed') ||
            e.message.includes('Browser has been closed')) {
          console.log('  Browser closed — saving progress and stopping post scraping');
          break;
        }
      }
    }
  }

  async scrapeComments(dir) {
    for (let i = 0; i < 20; i++) {
      let clicked = false;
      const btns = await this.page.$$('button');
      for (const btn of btns) {
        const text = await btn.textContent().catch(() => '');
        if (/more\s*comment|view\s*more|load\s*more|\d+\s*repl|show\s*more/i.test(text)) {
          const vis = await btn.isVisible().catch(() => false);
          if (vis) { await btn.click(); await this.page.waitForTimeout(800); clicked = true; break; }
        }
      }
      if (!clicked) break;
    }

    const comments = await this.page.evaluate(() => {
      const results = [];
      const seen = new Set();

      const bubbles = document.querySelectorAll('[class*="CommentItemBubble"]');
      for (const bubble of bubbles) {
        const authorEl = bubble.querySelector('a[href*="/@"]');
        const author = authorEl?.textContent?.trim() || '?';
        const paragraphs = bubble.querySelectorAll('[class*="Paragraph"]');
        let text = '';
        if (paragraphs.length > 0) {
          text = Array.from(paragraphs).map(p => p.textContent.trim()).filter(t => t).join('\n');
        }
        if (!text) {
          const clone = bubble.cloneNode(true);
          clone.querySelectorAll('[class*="Reaction"], [class*="TimeAgo"], [class*="Avatar"], button, svg, img, a[href*="/@"]').forEach(el => el.remove());
          text = clone.textContent.trim().replace(/\s+/g, ' ');
        }
        const key = `${author}:${text.substring(0, 50)}`;
        if (text && text.length > 1 && !seen.has(key)) {
          seen.add(key);
          results.push({ author, text });
        }
      }

      if (results.length === 0) {
        const items = document.querySelectorAll('[class*="CommentItem"]:not([class*="Input"]):not([class*="Wrapper"]):not([class*="Avatar"]):not([class*="Reactions"])');
        for (const item of items) {
          if (item.querySelector('[class*="CommentItemBubble"]') || item.querySelector('[class*="CommentItem"]')) continue;
          const authorEl = item.querySelector('a[href*="/@"]');
          if (!authorEl) continue;
          const author = authorEl.textContent.trim();
          const clone = item.cloneNode(true);
          clone.querySelectorAll('a[href*="/@"], [class*="Reaction"], [class*="TimeAgo"], button, svg, img, [class*="Avatar"]').forEach(el => el.remove());
          const text = clone.textContent.trim().replace(/\s+/g, ' ');
          const key = `${author}:${text.substring(0, 50)}`;
          if (text && text.length > 1 && text !== author && !seen.has(key)) {
            seen.add(key);
            results.push({ author, text });
          }
        }
      }

      if (results.length === 0) {
        const mainContent = document.querySelector('[class*="PostContent"], [class*="postContent"], article, [class*="styled__Content"]');
        if (mainContent) {
          const mainBottom = mainContent.getBoundingClientRect().bottom;
          const profileLinks = document.querySelectorAll('a[href*="/@"]');
          for (const link of profileLinks) {
            if (link.getBoundingClientRect().top <= mainBottom) continue;
            const author = link.textContent.trim();
            let container = link.parentElement;
            for (let j = 0; j < 5 && container; j++) {
              const children = container.querySelectorAll('a[href*="/@"]');
              if (children.length <= 1) { container = container.parentElement; continue; }
              break;
            }
            if (!container) continue;
            const clone = container.cloneNode(true);
            clone.querySelectorAll('a[href*="/@"], button, svg, img, [class*="Avatar"]').forEach(el => el.remove());
            const text = clone.textContent.trim().replace(/\s+/g, ' ');
            const key = `${author}:${text.substring(0, 50)}`;
            if (text && text.length > 3 && text !== author && !seen.has(key)) {
              seen.add(key);
              results.push({ author, text });
            }
          }
        }
      }

      return results;
    });

    if (comments.length) {
      fs.writeFileSync(path.join(dir, 'comments.md'),
        '# Comments\n\n' + comments.map(c => `**${c.author}:** ${c.text}`).join('\n\n---\n\n'));
      console.log(`    ${comments.length} comments`);
    }
  }

  // -----------------------------------------------------------------------
  // About
  // -----------------------------------------------------------------------
  async scrapeAbout() {
    console.log('\n=== Scraping About Page ===\n');
    const dir = path.join(CONFIG.downloadDir, '03-About');
    try {
      await this.goto(url('/about'));
      await this.page.waitForTimeout(2000);
      const nd = await this.getNextData();
      if (nd?.props?.pageProps) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '_nextdata.json'), JSON.stringify(nd.props.pageProps, null, 2));
      }
      await this.savePage(dir, url('/about'));
      console.log('  Done');
    } catch (e) { console.error(`  Error: ${e.message}`); }
  }

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------
  report() {
    const r = { community: CONFIG.slug, groupId: CONFIG.groupId, at: new Date().toISOString(), stats: this.stats, failed: this.failed };
    fs.writeFileSync(path.join(CONFIG.downloadDir, 'report.json'), JSON.stringify(r, null, 2));
    const s = `# Scrape Summary\n\n**${r.at}** | ${CONFIG.slug}\n\n| Metric | # |\n|---|---|\n| Posts | ${this.stats.posts} |\n| Lessons | ${this.stats.lessons} |\n| Files | ${this.stats.files} |\n| Skipped | ${this.stats.skipped} |\n| Errors | ${this.stats.errors} |\n\n${this.failed.length ? '## Failed\n' + this.failed.map(f => `- ${f.url}: ${f.error}`).join('\n') : ''}`;
    fs.writeFileSync(path.join(CONFIG.downloadDir, 'SUMMARY.md'), s);
    console.log('\n' + s);
  }

  // -----------------------------------------------------------------------
  // Run
  // -----------------------------------------------------------------------
  async run() {
    try {
      await this.init();
      await this.login();
      await this.scrapeClassroom();
      try {
        await this.scrapeCommunityPosts();
      } catch (e) {
        console.error(`Community posts error (progress saved): ${e.message}`);
      }
      try {
        await this.scrapeAbout();
      } catch (e) {
        console.error(`About page error: ${e.message}`);
      }
      this.report();
      console.log('\nDone! Run: node post-process.js');
    } catch (e) { console.error(`FATAL: ${e.message}\n${e.stack}`); }
    finally { if (this.browser) await this.browser.close(); }
  }
}

new SkoolScraper().run().catch(console.error);
