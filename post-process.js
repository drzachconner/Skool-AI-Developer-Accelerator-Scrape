/**
 * Post-Processor for Skool AI Developer Accelerator Scrape
 *
 * Generates:
 * 1. Master index (master-index.md) — CORE CURRICULUM first, then COMMUNITY POSTS
 * 2. HTML-to-Markdown conversion
 * 3. Skill/tool extraction
 * 4. Transcript compilation
 * 5. Comment re-extraction from saved HTML
 * 6. Post metadata extraction with tier tagging (creator/high/medium/low)
 * 7. High-value posts digest (high-value-posts.md) — 3+ upvotes, pinned, or creator
 * 8. Curriculum-only digest (curriculum-only.md) — zero community posts, clean for ingestion
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

  // Separate curriculum from community posts with clear headers
  // Sort so Classroom (02-) comes before Community Posts (01-)
  const curriculum = sections.filter(s => s.includes('Classroom') || s.includes('About'));
  const community = sections.filter(s => s.includes('Community') || s.includes('Posts'));
  const other = sections.filter(s => !curriculum.includes(s) && !community.includes(s));
  const orderedSections = [...curriculum, ...other, ...community];

  // Add section separators
  let inCurriculum = true;
  for (const section of orderedSections) {
    if (inCurriculum && (section.includes('Community') || section.includes('Posts'))) {
      lines.push('', '---', '', '# COMMUNITY POSTS', '', '*Posts are tiered: creator > high > medium > low. See high-value-posts.md for curated digest.*', '');
      inCurriculum = false;
    } else if (inCurriculum && curriculum.indexOf(section) === 0) {
      lines.push('# CORE CURRICULUM', '');
    }

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
// Community creator/admin usernames (for tier tagging)
// ---------------------------------------------------------------------------
const CREATOR_USERNAMES = ['brandonhancock', 'brandon-hancock', 'brandonjhancock'];

function isCreatorPost(entry) {
  const authorLower = (entry.author || '').toLowerCase().replace(/\s+/g, '');
  const usernameLower = (entry.authorUrl || '').toLowerCase();
  return CREATOR_USERNAMES.some(c =>
    authorLower.includes(c) || usernameLower.includes(c)
  ) || authorLower.includes('brandon');
}

function assignTier(entry) {
  if (isCreatorPost(entry)) return 'creator';
  if (entry.upvotes >= 5 || entry.isPinned) return 'high';
  if (entry.upvotes >= 2) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// 6. Extract post metadata from _nextdata.json (with tier tagging)
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
        tier: null, // assigned below
      };

      if (meta.contributors) {
        try {
          const contribs = typeof meta.contributors === 'string' ? JSON.parse(meta.contributors) : meta.contributors;
          if (Array.isArray(contribs)) entry.contributors = contribs.map(c => c.name || c.username || '?');
        } catch {}
      }

      entry.tier = assignTier(entry);
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

  // Tier summary
  const tierCounts = { creator: 0, high: 0, medium: 0, low: 0 };
  for (const e of allMeta) tierCounts[e.tier]++;

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
    '## Post Tiers',
    '',
    `| Tier | Count | Criteria |`,
    `|------|-------|----------|`,
    `| Creator | ${tierCounts.creator} | Posts by community owner (Brandon Hancock) |`,
    `| High | ${tierCounts.high} | 5+ upvotes or pinned |`,
    `| Medium | ${tierCounts.medium} | 2-4 upvotes |`,
    `| Low | ${tierCounts.low} | 0-1 upvotes |`,
    '',
    '## Top Posts by Engagement',
    '',
    '| Tier | Upvotes | Comments | Title | Author | Date |',
    '|------|---------|----------|-------|--------|------|',
  ];

  for (const e of allMeta.slice(0, 30)) {
    const date = e.createdAt ? e.createdAt.split('T')[0] : '?';
    lines.push(`| ${e.tier} | ${e.upvotes} | ${e.commentCount} | ${e.title.substring(0, 55)} | ${e.author} | ${date} |`);
  }

  lines.push('', '## All Posts (Chronological)', '');
  const chronological = [...allMeta].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  for (const e of chronological) {
    const date = e.createdAt ? e.createdAt.split('T')[0] : '?';
    const pinned = e.isPinned ? ' [PINNED]' : '';
    const label = e.labelName ? ` [${e.labelName}]` : '';
    const tier = ` [${e.tier.toUpperCase()}]`;
    lines.push(`- **${e.title}**${pinned}${label}${tier} -- ${e.author} (${date}) -- ${e.upvotes} upvotes, ${e.commentCount} comments`);
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
      for (const p of posts) lines.push(`- [${p.tier.toUpperCase()}] ${p.title} -- ${p.upvotes} upvotes`);
      lines.push('');
    }
  }

  const summaryPath = path.join(CONTENT_DIR, 'posts-metadata.md');
  fs.writeFileSync(summaryPath, lines.join('\n'));

  const jsonPath = path.join(CONTENT_DIR, 'posts-metadata.json');
  fs.writeFileSync(jsonPath, JSON.stringify(allMeta, null, 2));

  console.log(`  Extracted metadata for ${allMeta.length} posts`);
  console.log(`  Tiers: creator=${tierCounts.creator} high=${tierCounts.high} medium=${tierCounts.medium} low=${tierCounts.low}`);
  console.log(`  Summary: ${summaryPath}`);
  console.log(`  JSON: ${jsonPath}`);

  return allMeta;
}

// ---------------------------------------------------------------------------
// 7. Generate high-value-posts.md (3+ upvotes, creator, or pinned)
// ---------------------------------------------------------------------------
function generateHighValuePosts(allMeta) {
  console.log('\nGenerating high-value-posts.md...');

  const postsDir = path.join(CONTENT_DIR, '01-Community-Posts');
  if (!allMeta) {
    // Load from JSON if not passed
    const jsonPath = path.join(CONTENT_DIR, 'posts-metadata.json');
    if (fs.existsSync(jsonPath)) {
      allMeta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } else {
      console.log('  No metadata found. Run --extract-metadata first.');
      return;
    }
  }

  const highValue = allMeta.filter(e =>
    e.upvotes >= 3 || e.isPinned || isCreatorPost(e)
  ).sort((a, b) => b.upvotes - a.upvotes);

  const lines = [
    '# AI Developer Accelerator - High-Value Community Posts',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Filtered: ${highValue.length} posts (from ${allMeta.length} total)`,
    `Criteria: 3+ upvotes OR pinned OR by community creator`,
    '',
    '---',
    ''
  ];

  for (const e of highValue) {
    const date = e.createdAt ? e.createdAt.split('T')[0] : '?';
    const badges = [];
    if (e.isPinned) badges.push('PINNED');
    if (e.tier === 'creator') badges.push('CREATOR');
    const badgeStr = badges.length ? ` [${badges.join(', ')}]` : '';

    lines.push(`## ${e.title}${badgeStr}`, '');
    lines.push(`**Author:** ${e.author} | **Date:** ${date} | **Upvotes:** ${e.upvotes} | **Comments:** ${e.commentCount} | **Tier:** ${e.tier}`, '');

    // Include full content if available
    const contentPath = path.join(postsDir, e.dir, 'content.md');
    if (fs.existsSync(contentPath)) {
      const content = fs.readFileSync(contentPath, 'utf8')
        .replace(/---[\s\S]*?---/, '').trim();
      lines.push(content, '');
    }

    // Include comments summary
    const commentsPath = path.join(postsDir, e.dir, 'comments.md');
    if (fs.existsSync(commentsPath)) {
      const comments = fs.readFileSync(commentsPath, 'utf8');
      const commentCount = (comments.match(/\*\*/g) || []).length / 2;
      if (commentCount > 0) {
        lines.push(`### Comments (${Math.floor(commentCount)})`, '');
        lines.push(comments.replace('# Comments\n\n', ''), '');
      }
    }

    lines.push('---', '');
  }

  const outPath = path.join(CONTENT_DIR, 'high-value-posts.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  ${highValue.length} high-value posts written to ${outPath}`);
}

// ---------------------------------------------------------------------------
// 8. Generate curriculum-only.md (zero community posts)
// ---------------------------------------------------------------------------
function generateCurriculumOnly() {
  console.log('\nGenerating curriculum-only.md...');

  const classroomDir = path.join(CONTENT_DIR, '02-Classroom');
  if (!fs.existsSync(classroomDir)) {
    console.log('  No classroom directory found');
    return;
  }

  const lines = [
    '# AI Developer Accelerator - Core Curriculum',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'This document contains structured course content only (no community posts).',
    'Suitable for clean ingestion into NotebookLM or claude-code-toolkit.',
    '',
    '---',
    ''
  ];

  const courses = fs.readdirSync(classroomDir)
    .filter(d => fs.statSync(path.join(classroomDir, d)).isDirectory())
    .filter(d => !d.startsWith('_') && !d.startsWith('00'))
    .sort();

  let totalLessons = 0;

  for (const course of courses) {
    const courseDir = path.join(classroomDir, course);
    const courseName = course.replace(/-/g, ' ').replace(/^\d+-/, '');
    lines.push(`## ${courseName}`, '');

    // Read course metadata if available
    const metaPath = path.join(courseDir, '_course-meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const title = meta.metadata?.title || courseName;
        const desc = meta.metadata?.description;
        if (desc) lines.push(`*${desc}*`, '');
      } catch {}
    }

    // Read lessons index
    const indexPath = path.join(courseDir, '_lessons-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const lessons = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        lines.push(`**${lessons.length} lessons**`, '');

        // Group by parent module
        const modules = new Map();
        for (const lesson of lessons) {
          const mod = lesson.parentTitle || 'General';
          if (!modules.has(mod)) modules.set(mod, []);
          modules.get(mod).push(lesson);
        }

        for (const [modName, modLessons] of modules) {
          lines.push(`### ${modName}`, '');
          for (const lesson of modLessons) {
            lines.push(`#### ${lesson.title}`, '');
            totalLessons++;

            // Find and include lesson content
            const lessonContent = findLessonContent(courseDir, lesson);
            if (lessonContent) {
              lines.push(lessonContent, '');
            }

            // Note if transcript exists
            const transcriptPath = findLessonFile(courseDir, lesson, 'transcript.txt');
            if (transcriptPath) {
              const transcript = fs.readFileSync(transcriptPath, 'utf8').trim();
              if (transcript.length > 0) {
                lines.push('**Video Transcript:**', '');
                lines.push(transcript, '');
              }
            }

            lines.push('');
          }
        }
      } catch (e) {
        console.log(`  Error processing ${course}: ${e.message}`);
      }
    }

    lines.push('---', '');
  }

  lines.splice(7, 0, `Total courses: ${courses.length}`, `Total lessons: ${totalLessons}`, '');

  const outPath = path.join(CONTENT_DIR, 'curriculum-only.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  ${courses.length} courses, ${totalLessons} lessons written to ${outPath}`);
}

/** Find lesson content.md by searching module/lesson subdirectories */
function findLessonContent(courseDir, lesson) {
  const sanitizedParent = lesson.parentTitle ? sanitize(lesson.parentTitle).substring(0, 60) : 'General';
  const sanitizedTitle = sanitize(lesson.title);

  // Search for content.md in any matching directory
  const moduleDirs = fs.existsSync(path.join(courseDir, sanitizedParent))
    ? [path.join(courseDir, sanitizedParent)]
    : [];

  // Also check all subdirs
  try {
    const allDirs = fs.readdirSync(courseDir).filter(d =>
      fs.statSync(path.join(courseDir, d)).isDirectory()
    );
    for (const d of allDirs) {
      const subPath = path.join(courseDir, d);
      if (!moduleDirs.includes(subPath)) moduleDirs.push(subPath);
    }
  } catch {}

  for (const modDir of moduleDirs) {
    try {
      const lessonDirs = fs.readdirSync(modDir).filter(d => {
        const stripped = d.replace(/^\d+-/, '');
        return stripped.includes(sanitizedTitle.substring(0, 30)) || d.includes(sanitizedTitle.substring(0, 30));
      });
      for (const ld of lessonDirs) {
        const contentPath = path.join(modDir, ld, 'content.md');
        if (fs.existsSync(contentPath)) {
          return fs.readFileSync(contentPath, 'utf8')
            .replace(/---[\s\S]*?---/, '').trim();
        }
      }
    } catch {}
  }
  return null;
}

/** Find a specific file in lesson subdirectories */
function findLessonFile(courseDir, lesson, fileName) {
  const sanitizedParent = lesson.parentTitle ? sanitize(lesson.parentTitle).substring(0, 60) : 'General';
  const sanitizedTitle = sanitize(lesson.title);

  try {
    const allDirs = fs.readdirSync(courseDir).filter(d =>
      fs.statSync(path.join(courseDir, d)).isDirectory()
    );
    for (const d of allDirs) {
      const subPath = path.join(courseDir, d);
      try {
        const lessonDirs = fs.readdirSync(subPath).filter(ld => {
          const stripped = ld.replace(/^\d+-/, '');
          return stripped.includes(sanitizedTitle.substring(0, 30)) || ld.includes(sanitizedTitle.substring(0, 30));
        });
        for (const ld of lessonDirs) {
          const filePath = path.join(subPath, ld, fileName);
          if (fs.existsSync(filePath)) return filePath;
        }
      } catch {}
    }
  } catch {}
  return null;
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 200);
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
  else if (args.includes('--high-value')) generateHighValuePosts();
  else if (args.includes('--curriculum-only')) generateCurriculumOnly();
  else {
    // Run all steps in order
    generateMasterIndex();
    convertHtmlToMarkdown();
    extractSkillsAndTools();
    compileTranscripts();
    reExtractComments();
    const allMeta = extractPostMetadata();
    generateHighValuePosts(allMeta);
    generateCurriculumOnly();
  }

  console.log('\n==============================================');
  console.log('  Post-processing complete!');
  console.log('==============================================\n');
  console.log('Output:');
  console.log(`  - Master index: ${path.join(CONTENT_DIR, 'master-index.md')}`);
  console.log(`  - Curriculum only: ${path.join(CONTENT_DIR, 'curriculum-only.md')}`);
  console.log(`  - High-value posts: ${path.join(CONTENT_DIR, 'high-value-posts.md')}`);
  console.log(`  - Post metadata: ${path.join(CONTENT_DIR, 'posts-metadata.md')}`);
  console.log(`  - Extracted skills: ${SKILLS_DIR}/`);
}

main();
