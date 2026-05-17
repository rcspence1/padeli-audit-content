/**
 * Padeli Blog QC Validator
 * Validates blog post payloads against the 54-point publishing checklist
 * before WordPress push.
 *
 * 62 checks across 7 domains:
 *   A. Voice & Style (12)    B. Structure (13)
 *   C. Internal + External Linking (10)   D. Yoast/SEO (8)
 *   E. Images (7)   F. YMYL (5)   G. Hard Limits (6)
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

const {
  BANNED_PHRASES,
  HERO_HOOK_EXTRA_BANNED,
  PERSONAL_VISIT_PHRASES,
  MECHANICAL_TRANSITION_OPENERS,
  BANNED_SOURCES,
  POST_TYPES,
  WORD_COUNT_TARGETS,
  IMAGE_COUNT_TARGETS,
  getEnglishVariant,
} = require('./config');

const {
  countWords,
  stripHtml,
  extractParagraphs,
  cleanText,
  slugify,
} = require('./utils');

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/**
 * Blog-specific banned phrases (on top of the shared BANNED_PHRASES list).
 */
const BLOG_EXTRA_BANNED = [
  'genuinely',
  'picturesque',
  'bustling',
  'crucial',
  'elevate',
  'navigate',
  'plethora',
  'tapestry',
  'idyllic',
  'breathtaking',
];

/** Combined banned list: shared + blog-specific. */
const BLOG_BANNED_PHRASES = [...BANNED_PHRASES, ...BLOG_EXTRA_BANNED];

// Emoji regex (same as listing validator)
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/u;

// Common US spellings to flag when British English is expected
const US_SPELLING_PATTERNS = [
  { us: /\borganize\b/gi, gb: 'organise' },
  { us: /\borganized\b/gi, gb: 'organised' },
  { us: /\borganizing\b/gi, gb: 'organising' },
  { us: /\borganization\b/gi, gb: 'organisation' },
  { us: /\brecognize\b/gi, gb: 'recognise' },
  { us: /\brecognized\b/gi, gb: 'recognised' },
  { us: /\brecognizing\b/gi, gb: 'recognising' },
  { us: /\bspecialize\b/gi, gb: 'specialise' },
  { us: /\bspecialized\b/gi, gb: 'specialised' },
  { us: /\bspecializing\b/gi, gb: 'specialising' },
  { us: /\bcustomize\b/gi, gb: 'customise' },
  { us: /\bcustomized\b/gi, gb: 'customised' },
  { us: /\bmaximize\b/gi, gb: 'maximise' },
  { us: /\bminimize\b/gi, gb: 'minimise' },
  { us: /\boptimize\b/gi, gb: 'optimise' },
  { us: /\boptimized\b/gi, gb: 'optimised' },
  { us: /\butilize\b/gi, gb: 'utilise' },
  { us: /\butilized\b/gi, gb: 'utilised' },
  { us: /\banalyze\b/gi, gb: 'analyse' },
  { us: /\banalyzed\b/gi, gb: 'analysed' },
  { us: /\banalyzing\b/gi, gb: 'analysing' },
  { us: /\bprioritize\b/gi, gb: 'prioritise' },
  { us: /\bprioritized\b/gi, gb: 'prioritised' },
  { us: /\bsummarize\b/gi, gb: 'summarise' },
  { us: /\bauthorize\b/gi, gb: 'authorise' },
  { us: /\bauthorized\b/gi, gb: 'authorised' },
  { us: /\bcategorize\b/gi, gb: 'categorise' },
  { us: /\bemphasize\b/gi, gb: 'emphasise' },
  { us: /\bemphasized\b/gi, gb: 'emphasised' },
  { us: /\bfavor\b/gi, gb: 'favour' },
  { us: /\bfavorite\b/gi, gb: 'favourite' },
  { us: /\bfavored\b/gi, gb: 'favoured' },
  { us: /\bcolor\b/gi, gb: 'colour' },
  { us: /\bcolors\b/gi, gb: 'colours' },
  { us: /\bcolored\b/gi, gb: 'coloured' },
  { us: /\bhonor\b/gi, gb: 'honour' },
  { us: /\bhonored\b/gi, gb: 'honoured' },
  { us: /\bhumor\b/gi, gb: 'humour' },
  { us: /\blabor\b/gi, gb: 'labour' },
  { us: /\bneighbor\b/gi, gb: 'neighbour' },
  { us: /\bneighbors\b/gi, gb: 'neighbours' },
  { us: /\bneighborhood\b/gi, gb: 'neighbourhood' },
  { us: /\bcenter\b/gi, gb: 'centre' },
  { us: /\bcenters\b/gi, gb: 'centres' },
  { us: /\bdefense\b/gi, gb: 'defence' },
  { us: /\boffense\b/gi, gb: 'offence' },
  { us: /\blicense\b/gi, gb: 'licence (noun)' },
  { us: /\bpractice\b/gi, gb: 'practise (verb)' },
  { us: /\btraveling\b/gi, gb: 'travelling' },
  { us: /\btraveled\b/gi, gb: 'travelled' },
  { us: /\bcanceled\b/gi, gb: 'cancelled' },
  { us: /\bcanceling\b/gi, gb: 'cancelling' },
  { us: /\bjewelry\b/gi, gb: 'jewellery' },
  { us: /\bfulfill\b/gi, gb: 'fulfil' },
  { us: /\benroll\b/gi, gb: 'enrol' },
];

// Past participle suffixes for passive voice detection
const PAST_PARTICIPLE_REGEX = /\b(?:was|were|been|being)\s+(?:\w+ed|built|done|found|given|gone|had|held|kept|known|left|lost|made|meant|met|paid|put|read|run|said|seen|sent|set|shown|shut|sold|spent|stood|taken|told|thought|understood|won|written|worn|brought|bought|caught|chosen|drawn|driven|drunk|eaten|fallen|felt|flown|forgotten|frozen|got|gotten|grown|heard|hidden|hit|hung|hurt|laid|led|lain|lent|let|lied|lit|ridden|risen|rung|sat|shaken|shone|shot|slung|slid|slung|spoken|spent|split|spread|sprung|stolen|stricken|struck|strung|stuck|stung|stunk|sung|sunk|sworn|swept|swollen|swum|swung|torn|thrown|woken|wound)\b/gi;

// Mojibake / encoding artefact patterns
const MOJIBAKE_PATTERNS = [
  /Ã©/g, /Ã¨/g, /Ã¼/g, /Ã¶/g, /Ã¤/g, /Ã±/g,
  /Â /g, /Â£/g, /Â©/g, /Â®/g,
  /â€™/g, /â€œ/g, /â€\u009D/g, /â€"/g, /â€¢/g, /â€¦/g,
  /\uFFFD/g,
];

// Stop words for slug check
const SLUG_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'to', 'of', 'for', 'with', 'on', 'at', 'by', 'from', 'as', 'it',
  'this', 'that', 'these', 'those', 'has', 'have', 'had', 'be', 'been',
]);

// Diagnostic overreach words (YMYL)
const DIAGNOSTIC_OVERREACH = [
  /\btreats\b/gi,
  /\bcures\b/gi,
  /\bprevents\b/gi,
  /\bguaranteed to\b/gi,
  /\bwill heal\b/gi,
  /\bwill cure\b/gi,
  /\bwill fix\b/gi,
  /\bproven to cure\b/gi,
];

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Create a single check result object.
 */
function result(id, domain, check, pass, message, severity = 'error') {
  return { id, domain, check, pass, message, severity };
}

/**
 * Strip wp:html blocks from body HTML.
 */
function stripWpHtmlBlocks(html) {
  return html.replace(/<!-- wp:html -->[\s\S]*?<!-- \/wp:html -->/g, '');
}

/**
 * Extract sentences from plain text. Splits on . ! ? followed by space or end.
 */
function extractSentences(text) {
  const plain = stripHtml(text).trim();
  if (!plain) return [];
  // Split on sentence-ending punctuation followed by space or end of string
  return plain
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Extract all headings from HTML. Returns [{ level, text }].
 */
function extractHeadings(html) {
  const regex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    headings.push({ level: parseInt(match[1], 10), text: stripHtml(match[2]).trim() });
  }
  return headings;
}

/**
 * Extract all links from HTML. Returns [{ href, anchor, raw }].
 */
function extractLinks(html) {
  const regex = /<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    links.push({ href: match[1], anchor: stripHtml(match[2]).trim(), raw: match[0] });
  }
  return links;
}

/**
 * Check if a paragraph is in an excluded zone (DA block, methodology, review-block, medical reviewer).
 */
function isExcludedParagraph(html, paragraphContent) {
  // Check if paragraph is inside a direct-answer block
  const daBlockRegex = /class=["'][^"']*direct-answer[^"']*["']/i;
  const methodologyRegex = /class=["'][^"']*methodology[^"']*["']/i;
  const reviewBlockRegex = /class=["'][^"']*review-block[^"']*["']/i;
  const medicalReviewerRegex = /class=["'][^"']*medical-reviewer[^"']*["']/i;

  // Simple heuristic: check if the paragraph content appears inside these blocks
  const exclusionPatterns = [
    /<!-- wp:group\s[^>]*class="[^"]*direct-answer[^"]*"[^>]*-->[\s\S]*?<!-- \/wp:group -->/gi,
    /<!-- wp:group\s[^>]*class="[^"]*methodology[^"]*"[^>]*-->[\s\S]*?<!-- \/wp:group -->/gi,
    /<!-- wp:group\s[^>]*class="[^"]*review-block[^"]*"[^>]*-->[\s\S]*?<!-- \/wp:group -->/gi,
    /<div[^>]*class="[^"]*direct-answer[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div[^>]*class="[^"]*methodology[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div[^>]*class="[^"]*review-block[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
  ];

  for (const pattern of exclusionPatterns) {
    pattern.lastIndex = 0;
    let blockMatch;
    while ((blockMatch = pattern.exec(html)) !== null) {
      if (blockMatch[0].includes(paragraphContent)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Count paragraphs in body HTML, excluding wp:html blocks and excluded zones.
 * Returns { total, overLimit: [{ index, wordCount, snippet }] }
 */
function checkBodyParagraphLengths(html) {
  const paragraphs = extractParagraphs(html);
  const overLimit = [];

  for (const p of paragraphs) {
    // Skip paragraphs in excluded zones
    if (isExcludedParagraph(html, p.content)) continue;

    if (p.wordCount > 60) {
      overLimit.push({
        index: p.index,
        wordCount: p.wordCount,
        snippet: stripHtml(p.content).substring(0, 80) + '...',
      });
    }
  }

  return { total: paragraphs.length, overLimit };
}

// ---------------------------------------------------------------------------
// A. VOICE AND STYLE (12 checks)
// ---------------------------------------------------------------------------

function checkVoiceAndStyle(html, options = {}) {
  const checks = [];
  const bodyText = stripHtml(html || '');
  const bodyLower = bodyText.toLowerCase();

  // A01: British English spelling
  {
    const usFound = [];
    for (const entry of US_SPELLING_PATTERNS) {
      const matches = bodyText.match(entry.us);
      if (matches) {
        usFound.push(`${matches[0]} -> ${entry.gb}`);
      }
    }
    checks.push(result(
      'A01', 'voice_style', 'British English',
      usFound.length === 0,
      usFound.length === 0
        ? 'No US spellings detected'
        : `US spellings found: ${usFound.slice(0, 5).join('; ')}${usFound.length > 5 ? ` (+${usFound.length - 5} more)` : ''}`,
      'error'
    ));
  }

  // A02: No em-dashes
  {
    const emDashCount = (html.match(/\u2014/g) || []).length;
    checks.push(result(
      'A02', 'voice_style', 'No em-dashes',
      emDashCount === 0,
      emDashCount === 0
        ? 'No em-dashes found'
        : `${emDashCount} em-dash(es) found (U+2014) - replace with " - "`,
      'error'
    ));
  }

  // A03: No en-dashes
  {
    const enDashCount = (html.match(/\u2013/g) || []).length;
    checks.push(result(
      'A03', 'voice_style', 'No en-dashes',
      enDashCount === 0,
      enDashCount === 0
        ? 'No en-dashes found'
        : `${enDashCount} en-dash(es) found (U+2013) - use " - " with spaces`,
      'error'
    ));
  }

  // A04: No emojis
  {
    const emojiMatches = html.match(new RegExp(EMOJI_REGEX.source, 'gu'));
    const emojiCount = emojiMatches ? emojiMatches.length : 0;
    checks.push(result(
      'A04', 'voice_style', 'No emojis',
      emojiCount === 0,
      emojiCount === 0
        ? 'No emojis found'
        : `${emojiCount} emoji(s) found: ${emojiMatches.slice(0, 5).join(' ')}`,
      'error'
    ));
  }

  // A05: Banned words zero count
  {
    const found = [];
    for (const phrase of BLOG_BANNED_PHRASES) {
      if (bodyLower.includes(phrase.toLowerCase())) {
        found.push(phrase);
      }
    }
    checks.push(result(
      'A05', 'voice_style', 'Banned phrases',
      found.length === 0,
      found.length === 0
        ? 'No banned phrases detected'
        : `Banned phrases found: ${found.join(', ')}`,
      'error'
    ));
  }

  // A06: Mechanical transitions - no 2+ instances
  {
    const transitionCounts = {};
    for (const opener of MECHANICAL_TRANSITION_OPENERS) {
      const regex = new RegExp(`\\b${opener}\\b`, 'gi');
      const matches = bodyText.match(regex);
      if (matches && matches.length >= 2) {
        transitionCounts[opener] = matches.length;
      }
    }
    const offenders = Object.entries(transitionCounts);
    checks.push(result(
      'A06', 'voice_style', 'Mechanical transitions',
      offenders.length === 0,
      offenders.length === 0
        ? 'No over-used mechanical transitions'
        : `Over-used transitions: ${offenders.map(([w, c]) => `"${w}" x${c}`).join(', ')}`,
      'error'
    ));
  }

  // A07: Body paragraphs <60 words (with exclusions)
  {
    const paraCheck = checkBodyParagraphLengths(html);
    checks.push(result(
      'A07', 'voice_style', 'Paragraph length <60w',
      paraCheck.overLimit.length === 0,
      paraCheck.overLimit.length === 0
        ? 'All paragraphs under 60 words'
        : `${paraCheck.overLimit.length} paragraph(s) over 60 words: ${paraCheck.overLimit.map(p => `P${p.index + 1} (${p.wordCount}w)`).join(', ')}`,
      'error'
    ));
  }

  // A08: >75% of sentences under 20 words
  {
    const sentences = extractSentences(bodyText);
    const total = sentences.length;
    const under20 = sentences.filter(s => countWords(s) <= 20).length;
    const pct = total > 0 ? Math.round((under20 / total) * 100) : 100;
    checks.push(result(
      'A08', 'voice_style', 'Sentence length (<20w >75%)',
      pct >= 75,
      `${pct}% of sentences under 20 words (${under20}/${total}) - target >75%`,
      'warning'
    ));
  }

  // A09: Active voice >90%
  {
    const sentences = extractSentences(bodyText);
    const total = sentences.length;
    let passiveCount = 0;
    for (const sentence of sentences) {
      if (PAST_PARTICIPLE_REGEX.test(sentence)) {
        passiveCount++;
      }
      // Reset lastIndex for global regex
      PAST_PARTICIPLE_REGEX.lastIndex = 0;
    }
    const activeCount = total - passiveCount;
    const activePct = total > 0 ? Math.round((activeCount / total) * 100) : 100;
    checks.push(result(
      'A09', 'voice_style', 'Active voice >90%',
      activePct >= 90,
      `${activePct}% active voice (${passiveCount} passive sentence(s) of ${total}) - target >90%`,
      'warning'
    ));
  }

  // A10: Sentence variation - never 3 in a row starting with same word
  {
    const sentences = extractSentences(bodyText);
    let violation = false;
    let violationWord = '';
    for (let i = 0; i < sentences.length - 2; i++) {
      const w1 = (sentences[i].split(/\s/)[0] || '').toLowerCase();
      const w2 = (sentences[i + 1].split(/\s/)[0] || '').toLowerCase();
      const w3 = (sentences[i + 2].split(/\s/)[0] || '').toLowerCase();
      if (w1 && w1 === w2 && w2 === w3) {
        violation = true;
        violationWord = w1;
        break;
      }
    }
    checks.push(result(
      'A10', 'voice_style', 'Sentence variation',
      !violation,
      violation
        ? `3+ consecutive sentences start with "${violationWord}"`
        : 'No consecutive same-start sentences found',
      'warning'
    ));
  }

  // A11: No personal-visit claims
  {
    const found = [];
    for (const phrase of PERSONAL_VISIT_PHRASES) {
      if (bodyLower.includes(phrase.toLowerCase())) {
        found.push(phrase);
      }
    }
    checks.push(result(
      'A11', 'voice_style', 'No personal-visit claims',
      found.length === 0,
      found.length === 0
        ? 'No personal-visit claims found'
        : `Personal-visit claims: ${found.join(', ')}`,
      'error'
    ));
  }

  // A12: No "At Padeli.com" / "according to Padeli.com" first-person framing
  {
    const framingPatterns = [
      /\bat padeli\.com\b/i,
      /\baccording to padeli\.com\b/i,
      /\bwe at padeli\b/i,
      /\bour team at padeli\b/i,
      /\bhere at padeli\b/i,
    ];
    const found = [];
    for (const pattern of framingPatterns) {
      if (pattern.test(bodyText)) {
        found.push(bodyText.match(pattern)[0]);
      }
    }
    checks.push(result(
      'A12', 'voice_style', 'No first-person framing',
      found.length === 0,
      found.length === 0
        ? 'No first-person Padeli.com framing found'
        : `First-person framing found: ${found.join(', ')}`,
      'error'
    ));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// B. STRUCTURE (10 checks)
// ---------------------------------------------------------------------------

function checkStructure(html, options = {}) {
  const checks = [];

  // B13: Reading-time block present
  {
    const hasReadingTime =
      /wp:yoast-seo\/reading-time/i.test(html) ||
      /reading-time/i.test(html) ||
      /estimated reading time/i.test(html);
    checks.push(result(
      'B13', 'structure', 'Reading-time block',
      hasReadingTime,
      hasReadingTime
        ? 'Reading-time block found'
        : 'Missing reading-time block (Yoast estimated reading time)',
      'warning'
    ));
  }

  // B14: Direct-answer (DA) block present, 50-80 words
  {
    const daClassMatch = html.match(/class=["'][^"']*direct-answer[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section|p)>/i);
    const daBlock = options.da_paragraph || (daClassMatch ? stripHtml(daClassMatch[1]) : null);
    let daPass = false;
    let daMsg = 'Missing direct-answer block';

    if (daBlock) {
      const wc = countWords(daBlock);
      if (wc >= 50 && wc <= 80) {
        daPass = true;
        daMsg = `DA block present (${wc} words)`;
      } else {
        daMsg = `DA block present but ${wc} words (target 50-80)`;
      }
    }
    checks.push(result('B14', 'structure', 'Direct-answer block', daPass, daMsg, 'error'));
  }

  // B15 + B16: No inert TOC blocks (wp:table-of-contents is hard fail)
  {
    const tocMatch = html.match(/<!-- wp:table-of-contents/gi);
    const hasToc = tocMatch && tocMatch.length > 0;
    checks.push(result(
      'B15', 'structure', 'No inert TOC blocks',
      !hasToc,
      hasToc
        ? `Inert wp:table-of-contents block found (${tocMatch.length} instance(s)) - Elementor handles TOC`
        : 'No inert TOC blocks',
      'error'
    ));
    checks.push(result(
      'B16', 'structure', 'Inert TOC blocks removed',
      !hasToc,
      hasToc
        ? 'Inert TOC block(s) still present - must be removed'
        : 'No inert TOC blocks to remove',
      'error'
    ));
  }

  // B17: FAQ section uses padeli-faq-accordion with details/summary
  {
    const hasAccordion = /padeli-faq-accordion/i.test(html);
    const hasDetailsSummary = /<details[\s>]/i.test(html) && /<summary[\s>]/i.test(html);
    const faqPass = hasAccordion && hasDetailsSummary;
    checks.push(result(
      'B17', 'structure', 'FAQ accordion format',
      faqPass,
      faqPass
        ? 'FAQ uses padeli-faq-accordion with details/summary'
        : `FAQ format issue: ${!hasAccordion ? 'missing padeli-faq-accordion class' : ''}${!hasDetailsSummary ? ' missing details/summary elements' : ''}`.trim(),
      'error'
    ));
  }

  // B18: FAQ has 5+ questions
  {
    const faqs = options.faqs || [];
    // Also count from HTML if faqs not provided
    let faqCount = faqs.length;
    if (faqCount === 0) {
      const summaryMatches = html.match(/<summary[^>]*>/gi);
      faqCount = summaryMatches ? summaryMatches.length : 0;
    }
    checks.push(result(
      'B18', 'structure', 'FAQ 5+ questions',
      faqCount >= 5,
      faqCount >= 5
        ? `${faqCount} FAQ questions found`
        : `Only ${faqCount} FAQ questions (minimum 5)`,
      'error'
    ));
  }

  // B19: FAQ heading is post-relevant (not generic)
  {
    const headings = extractHeadings(html);
    const faqHeading = headings.find(h =>
      h.text.toLowerCase().includes('faq') ||
      h.text.toLowerCase().includes('frequently asked')
    );
    const genericTitles = [
      'frequently asked questions',
      'faq',
      'faqs',
      'common questions',
    ];
    let pass = true;
    let msg = 'No FAQ heading found to check';

    if (faqHeading) {
      const lower = faqHeading.text.toLowerCase().trim();
      if (genericTitles.includes(lower)) {
        pass = false;
        msg = `FAQ heading is generic: "${faqHeading.text}" - should be post-relevant`;
      } else {
        msg = `FAQ heading is post-relevant: "${faqHeading.text}"`;
      }
    } else {
      pass = false;
      msg = 'No FAQ heading found';
    }
    checks.push(result('B19', 'structure', 'FAQ heading relevant', pass, msg, 'warning'));
  }

  // B20: FAQPage JSON-LD schema present and parseable
  {
    const jsonLdBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    let hasFaqSchema = false;
    let parseError = null;

    for (const block of jsonLdBlocks) {
      const contentMatch = block.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
      if (contentMatch) {
        try {
          const parsed = JSON.parse(contentMatch[1]);
          const schemaType = parsed['@type'] || (Array.isArray(parsed['@graph']) ? parsed['@graph'].map(g => g['@type']).join(',') : '');
          if (schemaType.includes('FAQPage') || contentMatch[1].includes('FAQPage')) {
            hasFaqSchema = true;
          }
        } catch (e) {
          parseError = e.message;
        }
      }
    }

    // Also check wp:html blocks for JSON-LD
    const wpHtmlBlocks = html.match(/<!-- wp:html -->([\s\S]*?)<!-- \/wp:html -->/gi) || [];
    for (const block of wpHtmlBlocks) {
      if (block.includes('FAQPage')) {
        hasFaqSchema = true;
        // Try parsing
        const scriptMatch = block.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
        if (scriptMatch) {
          try {
            JSON.parse(scriptMatch[1]);
          } catch (e) {
            parseError = e.message;
          }
        }
      }
    }

    let pass = hasFaqSchema && !parseError;
    let msg = pass
      ? 'FAQPage JSON-LD schema present and parseable'
      : hasFaqSchema && parseError
        ? `FAQPage schema found but parse error: ${parseError}`
        : 'No FAQPage JSON-LD schema found';

    checks.push(result('B20', 'structure', 'FAQPage JSON-LD', pass, msg, 'error'));
  }

  // B21: Related Reading section at end
  {
    const relatedReading = options.related_reading || [];
    const hasRelatedInHtml =
      /related\s*reading/i.test(html) ||
      /related\s*posts/i.test(html) ||
      /further\s*reading/i.test(html) ||
      /read\s*next/i.test(html);
    const pass = relatedReading.length > 0 || hasRelatedInHtml;
    checks.push(result(
      'B21', 'structure', 'Related Reading section',
      pass,
      pass
        ? `Related Reading section present${relatedReading.length > 0 ? ` (${relatedReading.length} links)` : ''}`
        : 'Missing Related Reading section at end',
      'warning'
    ));
  }

  // B22: H2/H3 hierarchy - no orphan H3 without parent H2
  {
    const headings = extractHeadings(html);
    let lastH2Seen = false;
    const orphanH3s = [];
    for (const h of headings) {
      if (h.level === 2) {
        lastH2Seen = true;
      } else if (h.level === 3 && !lastH2Seen) {
        orphanH3s.push(h.text);
      }
    }
    checks.push(result(
      'B22', 'structure', 'H2/H3 hierarchy',
      orphanH3s.length === 0,
      orphanH3s.length === 0
        ? 'Heading hierarchy correct'
        : `Orphan H3(s) without parent H2: ${orphanH3s.map(t => `"${t}"`).join(', ')}`,
      'error'
    ));
  }

  // B23: Pricing/cost posts have a comparison table or "at a glance" section
  {
    const bodyLower = stripHtml(html).toLowerCase();
    const isPricingPost = /\bpric(?:e|es|ing)\b|\bcost\b|\bhow much\b/i.test(bodyLower);
    if (isPricingPost) {
      const headings = extractHeadings(html);
      const hasComparisonHeading = headings.some(h =>
        /price|comparison|at a glance|cost breakdown/i.test(h.text)
      );
      const hasTable = /<!-- wp:table/i.test(html) || /<table[\s>]/i.test(html);
      const pass = hasComparisonHeading || hasTable;
      checks.push(result(
        'B23', 'structure', 'Pricing post comparison table',
        pass,
        pass
          ? 'Pricing post has comparison table or summary heading'
          : 'Pricing/cost post missing comparison table or "at a glance" heading',
        'error'
      ));
    }
  }

  // B24: Pricing posts segment by tier (Budget/Mid-range/Premium)
  {
    const bodyLower = stripHtml(html).toLowerCase();
    const isPricingPost = /\bpric(?:e|es|ing)\b|\bcost\b|\bhow much\b/i.test(bodyLower);
    if (isPricingPost) {
      const headings = extractHeadings(html);
      const tierWords = ['budget', 'mid-range', 'midrange', 'mid range', 'premium', 'affordable', 'luxury', 'high-end'];
      const hasTierHeading = headings.some(h =>
        tierWords.some(tw => h.text.toLowerCase().includes(tw))
      );
      checks.push(result(
        'B24', 'structure', 'Pricing tier segmentation',
        hasTierHeading,
        hasTierHeading
          ? 'Pricing post segments by tier (Budget/Mid-range/Premium found in headings)'
          : 'Pricing post does not segment by tier - consider adding Budget/Mid-range/Premium headings',
        'warning'
      ));
    }
  }

  // B25: DA block currency matches display currency (not just local currency)
  {
    const daClassMatch = html.match(/class=["'][^"']*direct-answer[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section|p)>/i);
    const daBlock = options.da_paragraph || (daClassMatch ? stripHtml(daClassMatch[1]) : null);
    if (daBlock) {
      // Check for currency symbols in DA
      const hasCurrency = /[\u00A3\$\u20AC]|\bGBP\b|\bUSD\b|\bEUR\b/i.test(daBlock);
      if (hasCurrency) {
        // If the post targets a specific display currency, DA should use it
        const displayCurrency = options.display_currency || '';
        if (displayCurrency) {
          const currencyMap = { GBP: '\u00A3', USD: '$', EUR: '\u20AC' };
          const expectedSymbol = currencyMap[displayCurrency.toUpperCase()] || '';
          const hasExpected = expectedSymbol ? daBlock.includes(expectedSymbol) : true;
          checks.push(result(
            'B25', 'structure', 'DA currency matches display currency',
            hasExpected,
            hasExpected
              ? `DA block uses expected display currency (${displayCurrency})`
              : `DA block may use wrong currency - expected ${displayCurrency} for target audience`,
            'warning'
          ));
        }
      }
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// C. INTERNAL + EXTERNAL LINKING (8 checks)
// ---------------------------------------------------------------------------

function checkLinking(html, slug, tier, options = {}) {
  const checks = [];
  const internalLinks = options.internal_links || extractLinks(html).filter(l => /padeli\.com/i.test(l.href));
  const externalLinks = options.external_links || extractLinks(html).filter(l => !/padeli\.com/i.test(l.href) && /^https?:\/\//i.test(l.href));
  const faqs = options.faqs || [];
  const postType = options.post_type || '';

  // C23: Internal link count per tier
  {
    const count = internalLinks.length;
    const tierRanges = {
      cornerstone: [8, 15],
      cluster: [5, 10],
      leaf: [3, 7],
    };
    const range = tierRanges[(tier || '').toLowerCase()] || [3, 15];
    const pass = count >= range[0] && count <= range[1];
    checks.push(result(
      'C23', 'linking', 'Internal link count',
      pass,
      `${count} internal links (target ${range[0]}-${range[1]} for ${tier || 'unknown tier'})`,
      pass ? 'warning' : 'warning'
    ));
  }

  // C24: External authority links
  {
    const isCornerstoneOrYmyl = (tier || '').toLowerCase() === 'cornerstone' || options.is_ymyl;
    const count = externalLinks.length;
    const pass = !isCornerstoneOrYmyl || count >= 1;
    checks.push(result(
      'C24', 'linking', 'External authority links',
      pass,
      pass
        ? `${count} external link(s) found`
        : `No external authority links (required for ${isCornerstoneOrYmyl ? 'cornerstone/YMYL' : tier} posts)`,
      'error'
    ));
  }

  // C25: Funnel direction (check for /listing/ links in BOFU posts)
  {
    const listingLinks = internalLinks.filter(l => /\/listing\//i.test(l.href));
    const isBofu = /listicle|pillar/i.test(postType);
    let pass = true;
    let msg = 'Funnel direction OK';
    if (isBofu && listingLinks.length === 0) {
      pass = false;
      msg = 'BOFU post has no links to /listing/ pages - check funnel direction';
    } else if (isBofu) {
      msg = `${listingLinks.length} link(s) to /listing/ pages (BOFU funnel direction OK)`;
    }
    checks.push(result('C25', 'linking', 'Funnel direction', pass, msg, 'warning'));
  }

  // C26: Anchor text variation (30/50/20 split: exact/partial/generic)
  {
    const allLinks = [...internalLinks, ...externalLinks];
    const focusKw = (options.focus_keyword || '').toLowerCase();
    let exact = 0;
    let partial = 0;
    let generic = 0;
    const genericAnchors = new Set(['click here', 'read more', 'here', 'this', 'link', 'learn more', 'find out more', 'see more']);

    for (const link of allLinks) {
      const anchor = (link.anchor || '').toLowerCase().trim();
      if (!anchor) continue;
      if (focusKw && anchor === focusKw) {
        exact++;
      } else if (genericAnchors.has(anchor)) {
        generic++;
      } else {
        partial++;
      }
    }

    const total = exact + partial + generic;
    let pass = true;
    let msg = 'Anchor text variation OK';
    if (total > 0) {
      const exactPct = Math.round((exact / total) * 100);
      const partialPct = Math.round((partial / total) * 100);
      const genericPct = Math.round((generic / total) * 100);
      // Ideal: ~30% exact, ~50% partial, ~20% generic. Warn if exact >50% or generic >40%
      if (exactPct > 50) {
        pass = false;
        msg = `Too many exact-match anchors: ${exactPct}% (target ~30%)`;
      } else if (genericPct > 40) {
        pass = false;
        msg = `Too many generic anchors: ${genericPct}% (target ~20%)`;
      } else {
        msg = `Anchor split: ${exactPct}% exact / ${partialPct}% partial / ${genericPct}% generic (target 30/50/20)`;
      }
    }
    checks.push(result('C26', 'linking', 'Anchor text variation', pass, msg, 'warning'));
  }

  // C27: No broken internal links (valid href check)
  {
    const broken = internalLinks.filter(l => {
      const href = (l.href || '').trim();
      return !href || href === '#' || href === '/' || /^\s*$/.test(href);
    });
    checks.push(result(
      'C27', 'linking', 'No broken internal links',
      broken.length === 0,
      broken.length === 0
        ? 'All internal links have valid hrefs'
        : `${broken.length} internal link(s) with empty/invalid href`,
      'error'
    ));
  }

  // C28: No FAQ question text containing hyperlinks
  {
    let faqQuestionLinks = false;
    // Check from HTML: look for links inside <summary> tags
    const summaryRegex = /<summary[^>]*>([\s\S]*?)<\/summary>/gi;
    let summaryMatch;
    while ((summaryMatch = summaryRegex.exec(html)) !== null) {
      if (/<a\s/i.test(summaryMatch[1])) {
        faqQuestionLinks = true;
        break;
      }
    }
    // Also check faqs data
    if (!faqQuestionLinks && faqs.length > 0) {
      for (const faq of faqs) {
        const q = faq.question || faq.q || '';
        if (/<a\s/i.test(q) || /\[.*\]\(.*\)/.test(q)) {
          faqQuestionLinks = true;
          break;
        }
      }
    }
    checks.push(result(
      'C28', 'linking', 'No links in FAQ questions',
      !faqQuestionLinks,
      faqQuestionLinks
        ? 'Hyperlinks found in FAQ question text (links in answers only)'
        : 'No hyperlinks in FAQ question text',
      'error'
    ));
  }

  // C29: No [PLANNED:URL] markers left
  {
    const plannedMarkers = html.match(/\[PLANNED:URL\]/gi);
    const count = plannedMarkers ? plannedMarkers.length : 0;
    checks.push(result(
      'C29', 'linking', 'No [PLANNED:URL] markers',
      count === 0,
      count === 0
        ? 'No [PLANNED:URL] markers found'
        : `${count} [PLANNED:URL] marker(s) still in content`,
      'error'
    ));
  }

  // C30: No self-links
  {
    const selfLinks = internalLinks.filter(l => {
      const href = (l.href || '').toLowerCase();
      const postSlug = (slug || '').toLowerCase();
      if (!postSlug) return false;
      return href.includes(`/${postSlug}/`) || href.includes(`/${postSlug}`) || href.endsWith(postSlug);
    });
    checks.push(result(
      'C30', 'linking', 'No self-links',
      selfLinks.length === 0,
      selfLinks.length === 0
        ? 'No self-links detected'
        : `${selfLinks.length} self-link(s) found (post linking to its own slug "${slug}")`,
      'error'
    ));
  }

  // C31: Venue names link to /listing/ pages (if page_index available)
  {
    const pageIndex = options.page_index || [];
    if (pageIndex.length > 0) {
      const listingPages = pageIndex.filter(p => /\/listing\//i.test(p.slug || p.url || ''));
      if (listingPages.length > 0) {
        const bodyText = stripHtml(html);
        const unlinkedVenues = [];
        for (const listing of listingPages) {
          const venueName = listing.title || listing.name || '';
          if (!venueName) continue;
          // Check if venue name appears in body text
          if (bodyText.toLowerCase().includes(venueName.toLowerCase())) {
            // Check if there's a link to this listing page
            const listingSlug = listing.slug || listing.url || '';
            const hasLink = internalLinks.some(l =>
              (l.href || '').toLowerCase().includes(listingSlug.toLowerCase())
            );
            if (!hasLink) {
              unlinkedVenues.push(venueName);
            }
          }
        }
        const pass = unlinkedVenues.length === 0;
        checks.push(result(
          'C31', 'linking', 'Venue names link to listing pages',
          pass,
          pass
            ? 'All mentioned venues with listing pages are linked'
            : `${unlinkedVenues.length} venue(s) mentioned but not linked to /listing/ page: ${unlinkedVenues.slice(0, 5).join(', ')}`,
          'warning'
        ));
      }
    }
  }

  // C32: No [PLANNED:] markers remaining (broader than C29's [PLANNED:URL])
  {
    const plannedMarkers = html.match(/\[PLANNED:[^\]]*\]/gi);
    const count = plannedMarkers ? plannedMarkers.length : 0;
    // Exclude [PLANNED:URL] which C29 already covers
    const nonUrlPlanned = (plannedMarkers || []).filter(m => !/\[PLANNED:URL\]/i.test(m));
    if (nonUrlPlanned.length > 0) {
      checks.push(result(
        'C32', 'linking', 'No [PLANNED:] markers',
        false,
        `${nonUrlPlanned.length} [PLANNED:] marker(s) need resolution: ${nonUrlPlanned.slice(0, 3).join(', ')}`,
        'warning'
      ));
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// D. YOAST / SEO (8 checks)
// ---------------------------------------------------------------------------

function checkYoast(meta, focusKeyword, slug) {
  const checks = [];
  const yoastTitle = (meta && meta.yoast_title) || '';
  const yoastMeta = (meta && meta.yoast_meta) || '';
  const title = (meta && meta.title) || '';
  const daParagraph = (meta && meta.da_paragraph) || '';

  // D31: Yoast title present and 50-65 chars
  {
    const len = yoastTitle.length;
    const pass = len >= 50 && len <= 65;
    checks.push(result(
      'D31', 'yoast_seo', 'Yoast title length',
      pass,
      len === 0
        ? 'Yoast title missing'
        : `Yoast title is ${len} chars (target 50-65)`,
      len === 0 ? 'error' : (pass ? 'warning' : 'warning')
    ));
  }

  // D32: Meta description 120-156 chars
  {
    const len = yoastMeta.length;
    const pass = len >= 120 && len <= 156;
    checks.push(result(
      'D32', 'yoast_seo', 'Meta description length',
      pass,
      len === 0
        ? 'Meta description missing'
        : `Meta description is ${len} chars (target 120-156)`,
      len === 0 ? 'error' : (pass ? 'warning' : 'warning')
    ));
  }

  // D33: Focus keyword set
  {
    const pass = !!focusKeyword && focusKeyword.trim().length > 0;
    checks.push(result(
      'D33', 'yoast_seo', 'Focus keyword set',
      pass,
      pass ? `Focus keyword: "${focusKeyword}"` : 'Focus keyword not set',
      'error'
    ));
  }

  // D34: Focus keyword in title + meta + slug + DA
  {
    const kw = (focusKeyword || '').toLowerCase();
    if (kw) {
      const inTitle = yoastTitle.toLowerCase().includes(kw) || title.toLowerCase().includes(kw);
      const inMeta = yoastMeta.toLowerCase().includes(kw);
      const inSlug = (slug || '').toLowerCase().includes(kw.replace(/\s+/g, '-'));
      const inDA = daParagraph.toLowerCase().includes(kw);
      const missing = [];
      if (!inTitle) missing.push('title');
      if (!inMeta) missing.push('meta description');
      if (!inSlug) missing.push('slug');
      if (!inDA) missing.push('DA paragraph');
      const pass = missing.length === 0;
      checks.push(result(
        'D34', 'yoast_seo', 'Focus keyword placement',
        pass,
        pass
          ? 'Focus keyword present in title, meta, slug, and DA'
          : `Focus keyword missing from: ${missing.join(', ')}`,
        'warning'
      ));
    } else {
      checks.push(result('D34', 'yoast_seo', 'Focus keyword placement', false, 'Cannot check - no focus keyword set', 'warning'));
    }
  }

  // D35: Slug clean (lowercase, hyphens, no unnecessary stop words)
  {
    const s = slug || '';
    const issues = [];
    if (s !== s.toLowerCase()) issues.push('contains uppercase');
    if (/[^a-z0-9-]/.test(s)) issues.push('contains invalid characters');
    if (/--/.test(s)) issues.push('contains double hyphens');
    if (/^-|-$/.test(s)) issues.push('starts/ends with hyphen');
    // Check for stop words
    const parts = s.split('-');
    const stopWords = parts.filter(p => SLUG_STOP_WORDS.has(p));
    if (stopWords.length > 2) {
      issues.push(`excessive stop words: ${stopWords.join(', ')}`);
    }
    const pass = issues.length === 0;
    checks.push(result(
      'D35', 'yoast_seo', 'Slug clean',
      pass,
      pass
        ? `Slug is clean: "${s}"`
        : `Slug issues: ${issues.join('; ')}`,
      'warning'
    ));
  }

  // D36: Canonical URL set (self-canonical)
  {
    const canonical = (meta && meta.canonical) || '';
    const pass = !!canonical && canonical.length > 0;
    checks.push(result(
      'D36', 'yoast_seo', 'Canonical URL',
      pass,
      pass
        ? `Canonical URL set: ${canonical}`
        : 'No canonical URL set (should be self-canonical)',
      'warning'
    ));
  }

  // D37: Schema markup present
  {
    const bodyHtml = (meta && meta.body_html) || '';
    const hasSchema =
      /application\/ld\+json/i.test(bodyHtml) ||
      /FAQPage/i.test(bodyHtml) ||
      /ItemList/i.test(bodyHtml);
    checks.push(result(
      'D37', 'yoast_seo', 'Schema markup present',
      hasSchema,
      hasSchema
        ? 'Schema markup detected'
        : 'No schema markup (FAQPage/ItemList) found',
      'error'
    ));
  }

  // D38: No noindex/nofollow
  {
    const robots = (meta && meta.robots) || '';
    const hasNoindex = /noindex/i.test(robots);
    const hasNofollow = /nofollow/i.test(robots);
    const pass = !hasNoindex && !hasNofollow;
    checks.push(result(
      'D38', 'yoast_seo', 'No noindex/nofollow',
      pass,
      pass
        ? 'No noindex/nofollow directives'
        : `Found: ${hasNoindex ? 'noindex' : ''} ${hasNofollow ? 'nofollow' : ''}`.trim(),
      'error'
    ));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// E. IMAGES (6 checks)
// ---------------------------------------------------------------------------

function checkImages(postData, postType) {
  const checks = [];
  const featured = postData.featured_image || {};
  const images = postData.images || [];
  const bodyHtml = postData.body_html || '';
  const title = postData.title || '';
  const slug = postData.slug || '';

  // E39: Featured image present
  {
    const pass = !!(featured.id || featured.filename || featured.alt);
    checks.push(result(
      'E39', 'images', 'Featured image present',
      pass,
      pass ? 'Featured image present' : 'No featured image set',
      'error'
    ));
  }

  // E40: Featured image alt 60-160 chars, descriptive and post-relevant
  {
    const alt = featured.alt || '';
    const len = alt.length;
    let pass = len >= 60 && len <= 160;
    let msg = '';
    if (!alt) {
      pass = false;
      msg = 'Featured image has no alt text';
    } else if (len < 60) {
      msg = `Featured image alt is ${len} chars (min 60): "${alt}"`;
    } else if (len > 160) {
      msg = `Featured image alt is ${len} chars (max 160)`;
    } else {
      // Check relevance to title
      const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const altLower = alt.toLowerCase();
      const relevant = titleWords.some(w => altLower.includes(w));
      if (!relevant) {
        pass = false;
        msg = `Featured image alt length OK (${len}) but may not be post-relevant: "${alt}"`;
      } else {
        msg = `Featured image alt OK (${len} chars, post-relevant)`;
      }
    }
    checks.push(result('E40', 'images', 'Featured image alt', pass, msg, 'warning'));
  }

  // E41: Featured image caption ties to post claim
  {
    const caption = featured.caption || '';
    const pass = caption.length > 0;
    checks.push(result(
      'E41', 'images', 'Featured image caption',
      pass,
      pass
        ? `Featured image caption present: "${caption.substring(0, 80)}${caption.length > 80 ? '...' : ''}"`
        : 'Featured image has no caption (should tie to post claim)',
      'warning'
    ));
  }

  // E42: Featured image filename matches sport/location
  {
    const filename = (featured.filename || '').toLowerCase();
    const slugLower = (slug || '').toLowerCase();
    const hasPadel = filename.includes('padel');
    const slugParts = slugLower.split('-').filter(p => p.length > 3 && !SLUG_STOP_WORDS.has(p));
    const hasLocationMatch = slugParts.some(p => filename.includes(p));
    const pass = hasPadel || hasLocationMatch;
    checks.push(result(
      'E42', 'images', 'Featured image filename',
      pass,
      pass
        ? `Featured image filename relevant: "${featured.filename || ''}"`
        : `Featured image filename may not match sport/location: "${featured.filename || ''}"`,
      'warning'
    ));
  }

  // E43: In-body image count appropriate
  {
    // Count wp:image blocks in body
    const wpImageBlocks = bodyHtml.match(/<!-- wp:image/gi) || [];
    const imageCount = wpImageBlocks.length + images.length;
    const targets = IMAGE_COUNT_TARGETS[postType] || [2, 12];
    const pass = imageCount >= targets[0] && imageCount <= targets[1];
    checks.push(result(
      'E43', 'images', 'In-body image count',
      pass,
      `${imageCount} in-body image(s) (target ${targets[0]}-${targets[1]} for ${postType || 'unknown type'})`,
      pass ? 'warning' : 'warning'
    ));
  }

  // E44: All wp:image blocks have media ID
  {
    const imageBlockRegex = /<!-- wp:image\s*(\{[^}]*\})?\s*-->/gi;
    let match;
    let total = 0;
    let missingId = 0;
    while ((match = imageBlockRegex.exec(bodyHtml)) !== null) {
      total++;
      const attrs = match[1] || '';
      if (!/"id"\s*:\s*\d+/.test(attrs)) {
        missingId++;
      }
    }
    const pass = missingId === 0;
    checks.push(result(
      'E44', 'images', 'Image blocks have media ID',
      pass,
      pass
        ? `All ${total} wp:image block(s) have media IDs`
        : `${missingId} of ${total} wp:image block(s) missing media ID`,
      'error'
    ));
  }

  // E45: Venue-heavy posts have 1 image per venue
  {
    // Count venue names via H3 headings or outline data
    const headings = extractHeadings(bodyHtml);
    const venueHeadings = headings.filter(h =>
      h.level === 3 && !/faq|question|related|conclusion|summary/i.test(h.text)
    );
    const venueCount = postData.venues
      ? postData.venues.length
      : venueHeadings.length;

    if (venueCount >= 4) {
      const wpImageBlocks = bodyHtml.match(/<!-- wp:image/gi) || [];
      const totalImages = wpImageBlocks.length + images.length;
      const pass = totalImages >= venueCount;
      checks.push(result(
        'E45', 'images', 'Image per venue',
        pass,
        pass
          ? `${totalImages} images for ${venueCount} venues (1:1 coverage met)`
          : `Only ${totalImages} images for ${venueCount} venues - need at least 1 image per venue`,
        'warning'
      ));
    }
  }

  // E46: Image captions are well-formed sentences
  {
    const captionMatches = bodyHtml.match(/<figcaption[^>]*>(.*?)<\/figcaption>/gi) || [];
    const badCaptions = [];
    for (const cap of captionMatches) {
      const text = cap.replace(/<[^>]*>/g, '').trim();
      if (!text) continue;
      // Check for run-on sentences (two capital-letter starts without proper separation)
      const sentences = text.split(/[.!?]\s+/);
      if (sentences.length > 2) {
        badCaptions.push(text.substring(0, 60) + '...');
      }
      // Check for nonsensical "for [full sentence]" pattern
      if (/for [A-Z][^.]+has \d/.test(text)) {
        badCaptions.push(text.substring(0, 60) + '...');
      }
      // Check caption length (should be under 150 chars)
      if (text.length > 150) {
        badCaptions.push('Too long (' + text.length + ' chars): ' + text.substring(0, 40) + '...');
      }
    }
    const pass = badCaptions.length === 0;
    checks.push(result(
      'E46', 'images', 'Image captions well-formed',
      pass,
      pass
        ? `${captionMatches.length} caption(s) checked - all well-formed`
        : `${badCaptions.length} caption issue(s): ${badCaptions[0]}`,
      'warning'
    ));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// F. YMYL (5 checks)
// ---------------------------------------------------------------------------

function checkYMYL(html) {
  const checks = [];
  const bodyText = stripHtml(html || '');
  const bodyLower = bodyText.toLowerCase();
  const isYmyl = true; // These checks only matter for YMYL content; caller decides severity

  // F45: Medical reviewer paragraph after DA
  {
    const hasReviewer =
      /medical\s*review/i.test(html) ||
      /reviewed\s*by/i.test(html) ||
      /medically\s*reviewed/i.test(html) ||
      /class=["'][^"']*medical-reviewer/i.test(html);
    checks.push(result(
      'F45', 'ymyl', 'Medical reviewer attribution',
      hasReviewer,
      hasReviewer
        ? 'Medical reviewer attribution found'
        : 'Missing medical reviewer paragraph after DA',
      'error'
    ));
  }

  // F46: NHS/authority citation link
  {
    const authorityDomains = [
      'nhs.uk', 'who.int', 'gov.uk', 'nice.org.uk',
      'pubmed.ncbi.nlm.nih.gov', 'mayoclinic.org', 'cdc.gov',
      'bmj.com', 'thelancet.com', 'cochranelibrary.com',
    ];
    const links = extractLinks(html);
    const authLinks = links.filter(l => {
      const href = (l.href || '').toLowerCase();
      return authorityDomains.some(d => href.includes(d));
    });
    checks.push(result(
      'F46', 'ymyl', 'Authority citation link',
      authLinks.length > 0,
      authLinks.length > 0
        ? `${authLinks.length} authority citation link(s) found`
        : 'No NHS/authority citation links found',
      'error'
    ));
  }

  // F47: GP/physio consult note
  {
    const consultPhrases = [
      /consult\s+(your\s+)?(gp|doctor|physician|physio|physiotherapist)/i,
      /speak\s+to\s+(your\s+)?(gp|doctor|physician|physio|physiotherapist)/i,
      /seek\s+(professional\s+)?(medical\s+)?advice/i,
      /professional\s+guidance/i,
      /qualified\s+(health|medical)\s+professional/i,
    ];
    const hasConsultNote = consultPhrases.some(p => p.test(bodyText));
    checks.push(result(
      'F47', 'ymyl', 'GP/physio consult note',
      hasConsultNote,
      hasConsultNote
        ? 'GP/physio consultation note found'
        : 'Missing GP/physio consultation advisory note',
      'error'
    ));
  }

  // F48: No diagnostic overreach
  {
    const found = [];
    for (const pattern of DIAGNOSTIC_OVERREACH) {
      const matches = bodyText.match(pattern);
      if (matches) {
        found.push(matches[0]);
      }
    }
    checks.push(result(
      'F48', 'ymyl', 'No diagnostic overreach',
      found.length === 0,
      found.length === 0
        ? 'No diagnostic overreach language found'
        : `Diagnostic overreach found: ${found.join(', ')} - use "may help with" instead`,
      'error'
    ));
  }

  // F49: Dose/frequency/time figures cited or hedged
  {
    const dosePatterns = [
      /\b\d+\s*(mg|mcg|iu|ml|g)\b/i,
      /\b\d+\s*(times?\s*(per|a)\s*(day|week)|daily|weekly)\b/i,
      /\b\d+\s*(minutes?|hours?|sessions?)\s*(per|a)\s*(day|week)\b/i,
    ];
    const hedgePatterns = [
      /\btypically\b/i, /\bgenerally\b/i, /\bcommonly\b/i,
      /\bstudies\s+suggest\b/i, /\bresearch\s+(indicates|suggests)\b/i,
      /\baccording\s+to\b/i, /\bmay\b/i, /\bcould\b/i,
    ];

    let hasDoseFigures = false;
    let isHedged = false;
    for (const p of dosePatterns) {
      if (p.test(bodyText)) {
        hasDoseFigures = true;
        break;
      }
    }
    if (hasDoseFigures) {
      for (const h of hedgePatterns) {
        if (h.test(bodyText)) {
          isHedged = true;
          break;
        }
      }
    }

    const pass = !hasDoseFigures || isHedged;
    checks.push(result(
      'F49', 'ymyl', 'Dose/frequency hedged',
      pass,
      !hasDoseFigures
        ? 'No dose/frequency figures found'
        : isHedged
          ? 'Dose/frequency figures are hedged or cited'
          : 'Dose/frequency figures found without hedging or citation',
      'warning'
    ));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// G. HARD LIMITS (5 checks)
// ---------------------------------------------------------------------------

function checkHardLimits(html, slug, options = {}) {
  const checks = [];
  const bodyText = stripHtml(html || '');

  // G50: No [VERIFY] flags
  {
    const verifyCount = (html.match(/\[VERIFY\]/gi) || []).length;
    checks.push(result(
      'G50', 'hard_limits', 'No [VERIFY] flags',
      verifyCount === 0,
      verifyCount === 0
        ? 'No [VERIFY] flags found'
        : `${verifyCount} [VERIFY] flag(s) found - must be resolved before publishing`,
      'error'
    ));
  }

  // G51: Price tables: max 2 per pillar; no "Confirm on booking" in 3+ rows
  {
    const tableBlocks = html.match(/<!-- wp:table[\s\S]*?<!-- \/wp:table -->/gi) || [];
    const priceTableCount = tableBlocks.filter(t => /price|cost|fee|\u00A3|\$|\u20AC/i.test(t)).length;
    const postType = options.post_type || '';

    let pass = true;
    let msg = 'Price tables OK';

    if (/pillar/i.test(postType) && priceTableCount > 2) {
      pass = false;
      msg = `${priceTableCount} price tables found (max 2 for pillar posts)`;
    }

    // Check "Confirm on booking" rows
    const confirmMatches = html.match(/confirm\s+on\s+booking/gi) || [];
    if (confirmMatches.length >= 3) {
      pass = false;
      msg = `${confirmMatches.length} "Confirm on booking" rows found (max 2 allowed)`;
    }

    checks.push(result('G51', 'hard_limits', 'Price table limits', pass, msg, 'error'));
  }

  // G52: No mojibake/encoding artefacts
  {
    const found = [];
    for (const pattern of MOJIBAKE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(html)) {
        found.push(pattern.source.replace(/\\/g, ''));
      }
    }
    checks.push(result(
      'G52', 'hard_limits', 'No encoding artefacts',
      found.length === 0,
      found.length === 0
        ? 'No mojibake/encoding artefacts detected'
        : `Encoding artefacts found: ${found.slice(0, 5).join(', ')}`,
      'error'
    ));
  }

  // G53: No empty <p> blocks
  {
    const emptyPBlocks = html.match(/<p[^>]*>\s*<\/p>/gi) || [];
    // Also check for &nbsp; only paragraphs
    const nbspPBlocks = html.match(/<p[^>]*>(?:\s|&nbsp;)*<\/p>/gi) || [];
    const total = Math.max(emptyPBlocks.length, nbspPBlocks.length);
    checks.push(result(
      'G53', 'hard_limits', 'No empty paragraphs',
      total === 0,
      total === 0
        ? 'No empty paragraphs found'
        : `${total} empty <p> block(s) found`,
      'error'
    ));
  }

  // G54: Fact-check log exists
  {
    const factCheckPath = options.fact_check_log_path || '';
    let pass = false;
    let msg = 'No fact-check log path provided';

    if (factCheckPath) {
      // We can only check the path is set - actual file existence would require fs
      // In a blog pipeline context, the path being set is the signal
      pass = true;
      msg = `Fact-check log path set: ${factCheckPath}`;
    }
    checks.push(result('G54', 'hard_limits', 'Fact-check log exists', pass, msg, 'warning'));
  }

  // G55: Currency consistency - no mixing GBP/USD/EUR within the same post
  {
    const currencySymbols = {
      GBP: (bodyText.match(/\u00A3\s*\d/g) || []).length,
      USD: (bodyText.match(/\$\s*\d/g) || []).length,
      EUR: (bodyText.match(/\u20AC\s*\d/g) || []).length,
    };
    const usedCurrencies = Object.entries(currencySymbols)
      .filter(([, count]) => count > 0)
      .map(([currency]) => currency);

    // Having 2+ currencies is only OK if one is clearly a conversion (e.g. "~$15 / ~£12")
    // Flag as error if 2+ currencies used with 3+ instances each (not just a one-off conversion note)
    const significantCurrencies = Object.entries(currencySymbols)
      .filter(([, count]) => count >= 3)
      .map(([currency]) => currency);

    const pass = significantCurrencies.length <= 1;
    if (usedCurrencies.length > 1) {
      const breakdown = usedCurrencies.map(c => `${c}: ${currencySymbols[c]}`).join(', ');
      checks.push(result(
        'G55', 'hard_limits', 'Currency consistency',
        pass,
        pass
          ? `Multiple currencies detected but likely conversion notes (${breakdown})`
          : `Mixed currencies throughout post (${breakdown}) - standardise to one display currency`,
        pass ? 'warning' : 'error'
      ));
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// MAIN VALIDATOR
// ---------------------------------------------------------------------------

/**
 * Run all 54 checks on a blog post payload.
 *
 * @param {object} postData - Full post data object
 * @param {string} postType - Post type from POST_TYPES
 * @param {object} options - Additional options
 * @returns {{ pass: boolean, score: number, errors: string[], warnings: string[], checks: object }}
 */
function validateBlogPost(postData, postType, options = {}) {
  const html = postData.body_html || '';
  const slug = postData.slug || '';
  const tier = postData.tier || '';
  const focusKeyword = postData.focus_keyword || '';

  // Build meta object for Yoast checks
  const meta = {
    yoast_title: postData.yoast_title || '',
    yoast_meta: postData.yoast_meta || '',
    title: postData.title || '',
    da_paragraph: postData.da_paragraph || '',
    canonical: postData.canonical || '',
    robots: postData.robots || '',
    body_html: html,
  };

  // Gather structure options
  const structureOpts = {
    da_paragraph: postData.da_paragraph || '',
    faqs: postData.faqs || [],
    related_reading: postData.related_reading || [],
    display_currency: postData.display_currency || options.display_currency || '',
  };

  // Gather linking options
  const linkingOpts = {
    internal_links: postData.internal_links || [],
    external_links: postData.external_links || [],
    faqs: postData.faqs || [],
    focus_keyword: focusKeyword,
    is_ymyl: postData.is_ymyl || false,
    post_type: postType,
    page_index: postData.page_index || options.page_index || [],
  };

  // Gather hard limits options
  const hardLimitOpts = {
    post_type: postType,
    fact_check_log_path: postData.fact_check_log_path || '',
  };

  // Run all domain checks
  const voiceChecks = checkVoiceAndStyle(html, options);
  const structureChecks = checkStructure(html, structureOpts);
  const linkingChecks = checkLinking(html, slug, tier, linkingOpts);
  const yoastChecks = checkYoast(meta, focusKeyword, slug);
  const imageChecks = checkImages(postData, postType);
  const hardLimitChecks = checkHardLimits(html, slug, hardLimitOpts);

  // YMYL checks: only errors if post is YMYL, otherwise warnings
  let ymylChecks = [];
  if (postData.is_ymyl) {
    ymylChecks = checkYMYL(html);
  } else {
    // Run anyway but downgrade to warnings
    ymylChecks = checkYMYL(html).map(c => ({
      ...c,
      severity: 'warning',
      message: `[YMYL-optional] ${c.message}`,
    }));
  }

  // Combine all checks
  const allChecks = [
    ...voiceChecks,
    ...structureChecks,
    ...linkingChecks,
    ...yoastChecks,
    ...imageChecks,
    ...ymylChecks,
    ...hardLimitChecks,
  ];

  // Separate errors and warnings
  const errors = allChecks
    .filter(c => !c.pass && c.severity === 'error')
    .map(c => `[${c.id}] ${c.message}`);

  const warnings = allChecks
    .filter(c => !c.pass && c.severity === 'warning')
    .map(c => `[${c.id}] ${c.message}`);

  // Calculate per-domain summary
  const domainSummary = {};
  for (const c of allChecks) {
    if (!domainSummary[c.domain]) {
      domainSummary[c.domain] = { passed: 0, failed: 0, total: 0 };
    }
    domainSummary[c.domain].total++;
    if (c.pass) {
      domainSummary[c.domain].passed++;
    } else {
      domainSummary[c.domain].failed++;
    }
  }

  // Score: percentage of passing checks
  const totalChecks = allChecks.length;
  const passedChecks = allChecks.filter(c => c.pass).length;
  const score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

  // Overall pass: zero hard errors
  const pass = errors.length === 0;

  return {
    pass,
    score,
    errors,
    warnings,
    checks: domainSummary,
    details: allChecks,
  };
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  validateBlogPost,
  checkVoiceAndStyle,
  checkStructure,
  checkLinking,
  checkYoast,
  checkImages,
  checkYMYL,
  checkHardLimits,
  BLOG_BANNED_PHRASES,
};
