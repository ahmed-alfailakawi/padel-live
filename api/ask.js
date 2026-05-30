const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SCHOLARS = {
  binbaz:    { name: 'ابن باز',             sites: ['binbaz', 'islamqa'] },
  uthaymeen: { name: 'ابن عثيمين',          sites: ['islamqa', 'islamweb'] },
  albani:    { name: 'الألباني',             sites: ['islamqa', 'islamweb'] },
  fawzan:    { name: 'الفوزان',             sites: ['islamqa', 'islamweb'] },
  alkamees:  { name: 'عثمان الخميس',        sites: ['islamqa', 'islamweb'] },
  aljaser:   { name: 'مطلق الجاسر',         sites: ['islamqa'] },
  alshikh:   { name: 'صالح آل الشيخ',       sites: ['islamqa'] },
  abdulaziz: { name: 'عبدالعزيز آل الشيخ',  sites: ['islamqa'] },
  albader:   { name: 'عبدالرزاق البدر',     sites: ['islamqa', 'albader'] },
};

const ARTICLE_PATTERNS = {
  islamqa:  /https?:\/\/islamqa\.info\/ar\/answers\/\d+\/[^\s"'<>]*/g,
  binbaz:   /https?:\/\/binbaz\.org\.sa\/fatwas\/\d+[^\s"'<>]*/g,
  islamweb: /https?:\/\/www\.islamweb\.net\/ar\/fatwa\/\d+[^\s"'<>]*/g,
  albader:  /https?:\/\/al-badr\.net\/[^\s"'<>]*/g,
};

const FETCH_TIMEOUT = 5000;

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FatwaBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ar,en;q=0.9',
      },
    });
    const text = await res.text();
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildSearchUrl(site, scholarName, question) {
  const q = encodeURIComponent(`${scholarName} ${question}`);
  switch (site) {
    case 'islamqa':
      return `https://islamqa.info/ar/search/?q=${q}`;
    case 'binbaz':
      return `https://binbaz.org.sa/fatwas?search=${q}`;
    case 'islamweb':
      return `https://www.islamweb.net/ar/search/?q=${q}`;
    case 'albader':
      return `https://al-badr.net/search?q=${q}`;
    default:
      return null;
  }
}

const REL_PATTERNS = {
  islamqa:  /href="(\/ar\/answers\/\d+\/[^"]+)"/g,
  binbaz:   /href="(\/fatwas\/\d+[^"]*)"/g,
  islamweb: /href="(\/ar\/fatwa\/\d+[^"]*)"/g,
};

const SITE_ORIGINS = {
  islamqa:  'https://islamqa.info',
  binbaz:   'https://binbaz.org.sa',
  islamweb: 'https://www.islamweb.net',
  albader:  'https://al-badr.net',
};

function extractArticleUrls(html, sites) {
  const found = new Set();
  for (const site of sites) {
    // Match absolute URLs
    const absP = ARTICLE_PATTERNS[site];
    if (absP) {
      absP.lastIndex = 0;
      let m;
      while ((m = absP.exec(html)) !== null) found.add(m[0].replace(/['">\s]+$/, ''));
    }
    // Match relative URLs and prepend origin
    const relP = REL_PATTERNS[site];
    if (relP && SITE_ORIGINS[site]) {
      relP.lastIndex = 0;
      let m;
      while ((m = relP.exec(html)) !== null) found.add(SITE_ORIGINS[site] + m[1].replace(/['">\s]+$/, ''));
    }
  }
  return [...found].slice(0, 3);
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

async function fetchScholarContent(scholarKey, scholarInfo, question) {
  const { name, sites } = scholarInfo;
  let allText = '';
  let sourceUrls = [];

  // Search each site and collect article URLs
  const searchResults = await Promise.all(
    sites.map(async (site) => {
      const searchUrl = buildSearchUrl(site, name, question);
      if (!searchUrl) return { site, html: null };
      const html = await fetchWithTimeout(searchUrl);
      return { site, html };
    })
  );

  // Extract article URLs from search result pages
  for (const { site, html } of searchResults) {
    if (!html) continue;
    const urls = extractArticleUrls(html, [site]);
    sourceUrls.push(...urls);
  }

  // Deduplicate URLs
  sourceUrls = [...new Set(sourceUrls)].slice(0, 3);

  // Fetch article pages in parallel
  const articleFetches = await Promise.all(
    sourceUrls.map(async (url) => {
      const html = await fetchWithTimeout(url);
      return { url, text: stripHtml(html) };
    })
  );

  const validArticles = articleFetches.filter(a => a.text.length > 100);

  for (const { text } of validArticles) {
    allText += '\n\n---\n\n' + text;
  }

  return {
    text: allText.trim(),
    urls: validArticles.map(a => a.url),
  };
}

async function getScholarFatwa(scholarKey, scholarInfo, question, claudeSystemPrompt) {
  const { text, urls } = await fetchScholarContent(scholarKey, scholarInfo, question);

  if (!text) {
    return {
      answer: 'لم أجد فتوى موثقة لهذا الشيخ في هذه المسألة',
      evidence: '',
      ruling: '',
      sourceUrl: '',
    };
  }

  const userMsg = `
السؤال: ${question}

اسم الشيخ: ${scholarInfo.name}

النصوص المستخرجة من مواقع الفتاوى:
${text}

استخرج فقط ما يخص الشيخ ${scholarInfo.name} من النصوص أعلاه وأجب بصيغة JSON:
{
  "answer": "...",
  "evidence": "...",
  "ruling": "..."
}
`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: claudeSystemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });

    const raw = response.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        answer: 'لم أجد فتوى موثقة لهذا الشيخ في هذه المسألة',
        evidence: '',
        ruling: '',
        sourceUrl: urls[0] || '',
      };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      answer:    parsed.answer    || 'لم أجد فتوى موثقة لهذا الشيخ في هذه المسألة',
      evidence:  parsed.evidence  || '',
      ruling:    parsed.ruling    || '',
      sourceUrl: urls[0]          || '',
    };
  } catch {
    return {
      answer: 'لم أجد فتوى موثقة لهذا الشيخ في هذه المسألة',
      evidence: '',
      ruling: '',
      sourceUrl: urls[0] || '',
    };
  }
}

async function getHadithAnswer(question) {
  const searchUrl = `https://islamqa.info/ar/search/?q=${encodeURIComponent(question)}`;
  const searchHtml = await fetchWithTimeout(searchUrl);
  let hadithText = '';
  let sourceUrls = [];

  if (searchHtml) {
    const urls = extractArticleUrls(searchHtml, ['islamqa']);
    sourceUrls = urls.slice(0, 2);

    const articleFetches = await Promise.all(
      sourceUrls.map(async (url) => {
        const html = await fetchWithTimeout(url);
        return { url, text: stripHtml(html) };
      })
    );

    for (const { text } of articleFetches.filter(a => a.text.length > 100)) {
      hadithText += '\n\n---\n\n' + text;
    }
  }

  const systemPrompt = `أنت متخصص في علوم الحديث النبوي.
مهمتك حصراً: استخرج المعلومات الحديثية من النصوص المقدمة لك فقط.
لا تضف أي معلومات من عندك أو من تدريبك.
إذا لم تجد في النصوص المقدمة معلومات كافية، اكتب: "لم أجد نصاً موثقاً لهذه المسألة في المصادر المتاحة".
أجب دائماً بالعربية وبصيغة JSON فقط.`;

  const userMsg = hadithText
    ? `السؤال الحديثي: ${question}\n\nالنصوص المستخرجة:\n${hadithText}\n\nأجب بصيغة JSON:\n{"answer":"...","evidence":"...","ruling":""}`
    : `السؤال الحديثي: ${question}\n\nلا توجد نصوص مستخرجة.\n\nأجب بصيغة JSON:\n{"answer":"لم أجد نصاً موثقاً لهذه المسألة في المصادر المتاحة","evidence":"","ruling":""}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });
    const raw = response.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { answer: 'لم أجد نصاً موثقاً', evidence: '', ruling: '', sourceUrl: sourceUrls[0] || '' };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      answer:    parsed.answer   || 'لم أجد نصاً موثقاً',
      evidence:  parsed.evidence || '',
      ruling:    parsed.ruling   || '',
      sourceUrl: sourceUrls[0]   || '',
    };
  } catch {
    return { answer: 'لم أجد نصاً موثقاً', evidence: '', ruling: '', sourceUrl: sourceUrls[0] || '' };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { question, mode } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }

  const STRICT_SYSTEM_PROMPT = `أنت مساعد متخصص في استخراج الفتاوى الإسلامية.
قواعد صارمة يجب الالتزام بها:
1. استخرج الإجابات حصراً من النصوص المقدمة لك في الرسالة.
2. لا تضف أي معلومات من معرفتك الخاصة أو من تدريبك تحت أي ظرف.
3. لا تخترع أو تفترض فتاوى غير موجودة في النصوص المقدمة.
4. إذا لم تجد في النصوص المقدمة ما يتعلق بالشيخ المطلوب أو بالسؤال المطروح، اكتب حرفياً: "لم أجد فتوى موثقة لهذا الشيخ في هذه المسألة"
5. أجب دائماً بالعربية الفصحى وبصيغة JSON فقط دون أي نص خارج الـ JSON.`;

  try {
    if (mode === 'hadith') {
      const hadithResult = await getHadithAnswer(question);
      return res.status(200).json({
        text:      hadithResult.answer,
        grade:     hadithResult.ruling || '',
        source:    hadithResult.evidence || '',
        sourceUrl: hadithResult.sourceUrl || '',
        scholars:  '',
        note:      '',
      });
    }

    // Fetch all scholars in parallel
    const scholarKeys = Object.keys(SCHOLARS);
    const scholarResults = await Promise.all(
      scholarKeys.map(key => getScholarFatwa(key, SCHOLARS[key], question, STRICT_SYSTEM_PROMPT))
    );

    const result = {};
    scholarKeys.forEach((key, i) => {
      result[key] = scholarResults[i];
    });

    // Build summary from Claude using only extracted texts
    const summaryTexts = scholarKeys
      .map(key => `${SCHOLARS[key].name}: ${result[key].answer}`)
      .filter(t => !t.includes('لم أجد فتوى موثقة'))
      .join('\n');

    let summary = '';
    if (summaryTexts) {
      try {
        const summaryResponse = await client.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 512,
          system: `أنت مساعد يلخص الفتاوى. لخّص النصوص التالية فقط دون إضافة أي معلومات من عندك. إذا كانت الفتاوى متفقة اذكر الاتفاق، وإن اختلفت اذكر الخلاف بإيجاز. أجب بالعربية فقط.`,
          messages: [{
            role: 'user',
            content: `السؤال: ${question}\n\nالفتاوى المستخرجة:\n${summaryTexts}\n\nاكتب ملخصاً موجزاً.`,
          }],
        });
        summary = summaryResponse.content[0].text.trim();
      } catch {
        summary = 'تعذّر إنشاء الملخص';
      }
    } else {
      summary = 'لم يُعثر على فتاوى موثقة للعلماء المطلوبين في هذه المسألة';
    }

    return res.status(200).json({
      summary,
      ...result,
    });
  } catch (err) {
    console.error('ask handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
