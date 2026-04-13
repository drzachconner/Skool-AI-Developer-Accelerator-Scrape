/**
 * Post-Processor for Skool AI Developer Accelerator Scrape
 *
 * Generates:
 * 1. Master index (master-index.md)
 * 2. HTML-to-Markdown conversion
 * 3. Skill/tool extraction
 * 4. Transcript compilation
 * 5. Comment re-extraction from saved HTML
 * 6. Post metadata extraction from _nextdata.json
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const CONTENT_DIR = path.join(__dirname, 'scraped-content');
const SKILLS_DIR = path.join(__dirname, 'extracted-skills');

function walkDir(dir, callback) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) walkDir(fullPath, callback);
    else callback(fullPath);
  }
}

// ---------------------------------------------------------------------------
// 1. Generate Master Index
// ---------------------------------------------------------------------------
function generateMasterIndex() {
  console.log('\nGenerating master index...');

  const lines = [
    '# AI Developer Accelerator - Skool Community Content Index',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '---',
    ''
  ];

  const sections = fs.readdirSync(CONTENT_DIR)
    .filter(f => fs.statSync(path.join(CONTENT_DIR, f)).isDirectory())
    .filter(f => !f.startsWith('_'))
    .sort();

  for (const section of sections) {
    lines.push(`## ${section.replace(/-/g, ' ').replace(/^\d+-/, '')}`, '');

    const sectionDir = path.join(CONTENT_DIR, section);
    const items = fs.readdirSync(sectionDir)
      .filter(f => fs.statSync(path.join(sectionDir, f)).isDirectory())
      .sort();

    for (const item of items) {
      const itemDir = path.join(sectionDir, item);
      const contentFile = path.join(itemDir, 'content.md');

      lines.push(`### ${item.replace(/-/g, ' ').replace(/^\d+-/, '')}`, '');

      if (fs.existsSync(contentFile)) {
        const content = fs.readFileSync(contentFile, 'utf8');
        const stripped = content.replace(/---[\s\S]*?---/, '').trim();
        const preview = stripped.substring(0, 500).trim();
        if (preview) {
          lines.push(preview, '');
          if (stripped.length > 500) lines.push('*(truncated)*', '');
        }
      }

      const files = [];
      walkDir(itemDir, (filePath) => {
        const rel = path.relative(itemDir, filePath);
        if (!['page.html', 'screenshot.png', 'content.md', 'links.md'].includes(rel)) files.push(rel);
      });

      if (files.length > 0) {
        lines.push('**Attached files:**');
        for (const f of files) lines.push(`- ${f}`);
        lines.push('');
      }

      const transcriptFile = path.join(itemDir, 'transcript.txt');
      if (fs.existsSync(transcriptFile)) lines.push('**Transcript:** transcript.txt', '');

      const subItems = fs.readdirSync(itemDir)
        .filter(f => fs.statSync(path.join(itemDir, f)).isDirectory())
        .sort();

      for (const sub of subItems) {
        const subDir = path.join(itemDir, sub);
        const subContentFile = path.join(subDir, 'content.md');
        lines.push(`#### ${sub.replace(/-/g, ' ').replace(/^\d+-/, '')}`);
        if (fs.existsSync(subContentFile)) {
          const subContent = fs.readFileSync(subContentFile, 'utf8')
            .replace(/---[\s\S]*?---/, '').trim();
          const subPreview = subContent.substring(0, 300).trim();
          if (subPreview) lines.push(subPreview, '');
        }
        const subTranscript = path.join(subDir, 'transcript.txt');
        if (fs.existsSync(subTranscript)) lines.push('**Transcript:** transcript.txt', '');

        if (fs.statSync(subDir).isDirectory()) {
          const deepItems = fs.readdirSync(subDir)
            .filter(f => fs.statSync(path.join(subDir, f)).isDirectory())
            .sort();
          for (const deep of deepItems) {
            const deepTranscript = path.join(subDir, deep, 'transcript.txt');
            if (fs.existsSync(deepTranscript)) {
              lines.push(`##### ${deep.replace(/-/g, ' ').replace(/^\d+-/, '')}`, '');
              lines.push('**Transcript:** transcript.txt', '');
            }
          }
        }
        lines.push('');
      }

      lines.push('---', '');
    }
  }

  const indexPath = path.join(CONTENT_DIR, 'master-index.md');
  fs.writeFileSync(indexPath, lines.join('\n'));
  console.log(`  Saved: ${indexPath}`);
}

// ---------------------------------------------------------------------------
// 2. Convert HTML to Markdown
// ---------------------------------------------------------------------------
function convertHtmlToMarkdown() {
  console.log('\nConverting HTML files to Markdown...');

  let hasPandoc = false;
  try {
    execFileSync('pandoc', ['--version'], { stdio: 'pipe' });
    hasPandoc = true;
    console.log('  Using pandoc for conversion');
  } catch {
    console.log('  pandoc not found, using basic HTML stripping');
  }

  let converted = 0;
  let skipped = 0;

  walkDir(CONTENT_DIR, (filePath) => {
    if (!filePath.endsWith('.html')) return;
    const mdPath = filePath.replace(/\.html$/, '.converted.md');
    if (fs.existsSync(mdPath)) { skipped++; return; }

    try {
      if (hasPandoc) {
        const output = execFileSync('pandoc', [
          filePath, '-f', 'html', '-t', 'markdown',
          '--wrap=none', '--strip-comments'
        ], { encoding: 'utf8', timeout: 30000 });
        if (output.trim().length > 100) {
          fs.writeFileSync(mdPath, output);
          converted++;
        }
      } else {
        const html = fs.readFileSync(filePath, 'utf8');
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length > 100) {
          fs.writeFileSync(mdPath, text);
          converted++;
        }
      }
    } catch (e) {
      console.log(`  Failed: ${path.basename(filePath)}: ${e.message}`);
    }
  });

  console.log(`  Converted: ${converted}, Skipped: ${skipped}`);
}

// ---------------------------------------------------------------------------
// 3. Extract Skills and Tools
// ---------------------------------------------------------------------------
function extractSkillsAndTools() {
  console.log('\nSearching for skills, tools, and .md files to extract...');

  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });

  let found = 0;

  walkDir(CONTENT_DIR, (filePath) => {
    if (filePath.includes('/files/') && filePath.endsWith('.md')) {
      const basename = path.basename(filePath);
      const dest = path.join(SKILLS_DIR, basename);
      fs.copyFileSync(filePath, dest);
      console.log(`  Extracted: ${basename}`);
      found++;
      return;
    }

    if (filePath.endsWith('content.md')) {
      const content = fs.readFileSync(filePath, 'utf8').toLowerCase();
      const isSkillRelated = (
        content.includes('skill') ||
        content.includes('claude code') ||
        content.includes('claude.md') ||
        content.includes('.claude/') ||
        content.includes('mcp') ||
        content.includes('cursor') ||
        content.includes('prompt') ||
        content.includes('agent') ||
        content.includes('workflow')
      );

      if (isSkillRelated) {
        const dir = path.dirname(filePath);
        const dirName = path.basename(dir);
        const dest = path.join(SKILLS_DIR, `${dirName}-content.md`);
        fs.copyFileSync(filePath, dest);
        found++;
      }
    }
  });

  console.log(`  Found ${found} skill/tool-related files`);

  console.log('\nScanning posts for embedded code/config blocks...');
  let codeBlocks = 0;

  walkDir(CONTENT_DIR, (filePath) => {
    if (!filePath.endsWith('content.md')) return;
    const content = fs.readFileSync(filePath, 'utf8');

    const codeBlockRegex = /```[\s\S]*?```/g;
    const matches = content.match(codeBlockRegex);
    if (!matches) return;

    for (const block of matches) {
      const code = block.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      if (code.includes('CLAUDE.md') || code.includes('skill') || code.includes('.claude/') ||
          code.includes('mcp') || code.includes('## ') || code.length > 200) {
        const dir = path.dirname(filePath);
        const dirName = path.basename(dir);
        const blockIndex = codeBlocks++;
        const dest = path.join(SKILLS_DIR, `${dirName}-codeblock-${blockIndex}.md`);
        fs.writeFileSync(dest, code);
      }
    }
  });

  console.log(`  Extracted ${codeBlocks} code blocks`);
}

// ---------------------------------------------------------------------------
// 4. Compile all transcripts
// ---------------------------------------------------------------------------
function compileTranscripts() {
  console.log('\nCompiling transcripts...');

  const transcripts = [];

  walkDir(CONTENT_DIR, (filePath) => {
    if (!filePath.endsWith('transcript.txt')) return;
    const rel = path.relative(CONTENT_DIR, filePath);
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (content.length > 0) {
      const parts = rel.split(path.sep);
      const courseName = parts[1] || 'Unknown';
      const lessonName = parts.slice(2, -1).join(' > ') || 'Unknown';
      transcripts.push({ path: rel, courseName, lessonName, content });
    }
  });

  if (transcripts.length === 0) {
    console.log('  No transcripts found');
    return;
  }

  const lines = [
    '# AI Developer Accelerator - All Video Transcripts',
    '',
    `Compiled: ${new Date().toISOString()}`,
    `Total transcripts: ${transcripts.length}`,
    '',
    '---',
    ''
  ];

  for (const t of transcripts) {
    lines.push(`## ${t.courseName} > ${t.lessonName}`, '');
    lines.push(`*Source: ${t.path}*`, '');
    lines.push(t.content, '');
    lines.push('---', '');
  }

  const outPath = path.join(CONTENT_DIR, 'all-transcripts.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Compiled ${transcripts.length} transcripts to ${outPath}`);
}

// ---------------------------------------------------------------------------
// 5. Re-extract comments from saved HTML
// ---------------------------------------------------------------------------
function reExtractComments() {
  console.log('\nRe-extracting comments from saved HTML files...');

  const postsDir = path.join(CONTENT_DIR, '01-Community-Posts');
  if (!fs.existsSync(postsDir)) { console.log('  No posts directory found'); return; }

  let extracted = 0;
  let skipped = 0;

  const postDirs = fs.readdirSync(postsDir)
    .filter(d => fs.statSync(path.join(postsDir, d)).isDirectory())
    .sort();

  for (const postDir of postDirs) {
    const htmlPath = path.join(postsDir, postDir, 'page.html');
    if (!fs.existsSync(htmlPath)) continue;

    const html = fs.readFileSync(htmlPath, 'utf8');

    const comments = [];
    const bubbleContentPattern = /CommentItemBubble[^>]*>(.*?)CommentItemReactions/gs;
    let bubbleMatch;
    while ((bubbleMatch = bubbleContentPattern.exec(html)) !== null) {
      const bubbleContent = bubbleMatch[1];

      const authorMatch = bubbleContent.match(/UserNameText[^>]*><span>([^<]+)/);
      let author = authorMatch ? authorMatch[1].trim() : null;
      if (!author) {
        const linkMatch = bubbleContent.match(/<a[^>]*href="[^"]*\?g=ai-developer-accelerator"[^>]*>([^<]+)/);
        author = linkMatch ? linkMatch[1].trim() : null;
      }
      if (!author) continue;

      author = author.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

      let text = '';
      const paraPattern = /Paragraph[^>]*>(.*?)(?:<\/div>){2}/gs;
      let pMatch;
      while ((pMatch = paraPattern.exec(bubbleContent)) !== null) {
        const pText = pMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ')
          .trim();
        if (pText) text += (text ? '\n' : '') + pText;
      }

      if (text && text.length > 1) {
        const exists = comments.some(c => c.author === author && c.text === text);
        if (!exists) comments.push({ author, text });
      }
    }

    if (comments.length > 0) {
      const commentsPath = path.join(postsDir, postDir, 'comments.md');
      fs.writeFileSync(commentsPath,
        '# Comments\n\n' + comments.map(c => `**${c.author}:** ${c.text}`).join('\n\n---\n\n'));
      console.log(`  ${postDir}: ${comments.length} comments`);
      extracted++;
    } else {
      skipped++;
    }
  }

  console.log(`  Re-extracted comments from ${extracted} posts (${skipped} had no comments)`);
}

// ---------------------------------------------------------------------------
// 6. Extract post metadata from _nextdata.json
// ---------------------------------------------------------------------------
function extractPostMetadata() {
  console.log('\nExtracting post metadata from _nextdata.json...');

  const postsDir = path.join(CONTENT_DIR, '01-Community-Posts');
  if (!fs.existsSync(postsDir)) { console.log('  No posts directory found'); return; }

  const allMeta = [];
  const labelMap = new Map();

  const postDirs = fs.readdirSync(postsDir)
    .filter(d => fs.statSync(path.join(postsDir, d)).isDirectory())
    .sort();

  for (const postDir of postDirs) {
    const ndPath = path.join(postsDir, postDir, '_nextdata.json');
    if (!fs.existsSync(ndPath)) continue;

    try {
      const nd = JSON.parse(fs.readFileSync(ndPath, 'utf8'));
      const post = nd.postTree?.post || nd.post || {};
      const meta = post.metadata || {};

      const entry = {
        dir: postDir,
        title: meta.title || post.name || postDir,
        author: post.user?.name || post.user?.username || '?',
        authorUrl: post.user?.username ? `https://www.skool.com/@${post.user.username}?g=ai-developer-accelerator` : null,
        createdAt: post.createdAt || null,
        updatedAt: post.updatedAt || null,
        upvotes: meta.upvotes || 0,
        commentCount: meta.comments || 0,
        labelId: post.labelId || meta.labels || null,
        isPinned: nd.isPinned || false,
        followers: nd.followers || 0,
        postType: post.postType || 'generic',
        hasVideo: !!(meta.videoIds),
        contributors: [],
      };

      if (meta.contributors) {
        try {
          const contribs = typeof meta.contributors === 'string' ? JSON.parse(meta.contributors) : meta.contributors;
          if (Array.isArray(contribs)) entry.contributors = contribs.map(c => c.name || c.username || '?');
        } catch {}
      }

      allMeta.push(entry);

      if (entry.labelId) {
        const htmlPath = path.join(postsDir, postDir, 'page.html');
        if (fs.existsSync(htmlPath) && !labelMap.has(entry.labelId)) {
          const html = fs.readFileSync(htmlPath, 'utf8');
          const labelMatch = html.match(/class="[^"]*Label[^"]*"[^>]*>([^<]{2,30})</i);
          if (labelMatch) labelMap.set(entry.labelId, labelMatch[1].trim());
        }
      }

      const metaPath = path.join(postsDir, postDir, 'metadata.json');
      fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2));

    } catch (e) {
      console.log(`  Failed: ${postDir}: ${e.message}`);
    }
  }

  for (const entry of allMeta) {
    entry.labelName = labelMap.get(entry.labelId) || null;
  }

  allMeta.sort((a, b) => b.upvotes - a.upvotes);

  const lines = [
    '# Community Posts - Metadata Summary',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Total posts: ${allMeta.length}`,
    `Total upvotes: ${allMeta.reduce((s, e) => s + e.upvotes, 0)}`,
    `Total comments: ${allMeta.reduce((s, e) => s + e.commentCount, 0)}`,
    `Pinned posts: ${allMeta.filter(e => e.isPinned).length}`,
    `Posts with video: ${allMeta.filter(e => e.hasVideo).length}`,
    '',
    '## Top Posts by Engagement',
    '',
    '| Upvotes | Comments | Title | Author | Date |',
    '|---------|----------|-------|--------|------|',
  ];

  for (const e of allMeta.slice(0, 30)) {
    const date = e.createdAt ? e.createdAt.split('T')[0] : '?';
    lines.push(`| ${e.upvotes} | ${e.commentCount} | ${e.title.substring(0, 60)} | ${e.author} | ${date} |`);
  }

  lines.push('', '## All Posts (Chronological)', '');
  const chronological = [...allMeta].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  for (const e of chronological) {
    const date = e.createdAt ? e.createdAt.split('T')[0] : '?';
    const pinned = e.isPinned ? ' [PINNED]' : '';
    const label = e.labelName ? ` [${e.labelName}]` : '';
    lines.push(`- **${e.title}**${pinned}${label} -- ${e.author} (${date}) -- ${e.upvotes} upvotes, ${e.commentCount} comments`);
  }

  const categories = new Map();
  for (const e of allMeta) {
    const cat = e.labelName || e.labelId || 'Uncategorized';
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push(e);
  }
  if (categories.size > 1) {
    lines.push('', '## Posts by Category', '');
    for (const [cat, posts] of categories) {
      lines.push(`### ${cat} (${posts.length} posts)`, '');
      for (const p of posts) lines.push(`- ${p.title} -- ${p.upvotes} upvotes`);
      lines.push('');
    }
  }

  const summaryPath = path.join(CONTENT_DIR, 'posts-metadata.md');
  fs.writeFileSync(summaryPath, lines.join('\n'));

  const jsonPath = path.join(CONTENT_DIR, 'posts-metadata.json');
  fs.writeFileSync(jsonPath, JSON.stringify(allMeta, null, 2));

  console.log(`  Extracted metadata for ${allMeta.length} posts`);
  console.log(`  Summary: ${summaryPath}`);
  console.log(`  JSON: ${jsonPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log('==============================================');
  console.log('  Skool AI Developer Accelerator Post-Processor');
  console.log('==============================================');

  if (!fs.existsSync(CONTENT_DIR)) {
    console.error(`Content directory not found: ${CONTENT_DIR}`);
    console.error('Run the scraper first: node downloader.js');
    process.exit(1);
  }

  const args = process.argv.slice(2);

  if (args.includes('--index-only')) generateMasterIndex();
  else if (args.includes('--convert-html')) convertHtmlToMarkdown();
  else if (args.includes('--extract-skills')) extractSkillsAndTools();
  else if (args.includes('--compile-transcripts')) compileTranscripts();
  else if (args.includes('--re-extract-comments')) reExtractComments();
  else if (args.includes('--extract-metadata')) extractPostMetadata();
  else {
    generateMasterIndex();
    convertHtmlToMarkdown();
    extractSkillsAndTools();
    compileTranscripts();
    reExtractComments();
    extractPostMetadata();
  }

  console.log('\n==============================================');
  console.log('  Post-processing complete!');
  console.log('==============================================\n');
  console.log('Output:');
  console.log(`  - Master index: ${path.join(CONTENT_DIR, 'master-index.md')}`);
  console.log(`  - Post metadata: ${path.join(CONTENT_DIR, 'posts-metadata.md')}`);
  console.log(`  - Extracted skills: ${SKILLS_DIR}/`);
}

main();
