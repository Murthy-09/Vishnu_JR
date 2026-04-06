// Vishnu JR -- Cloudflare Worker v4
// ES modules format. Secrets: env.NOTION_TOKEN, env.ANTHROPIC_KEY
// Notion page: 294eac182007812c9db6dfc7b40cbee3

const NOTION_PAGE_ID = '294eac182007812c9db6dfc7b40cbee3';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const RESULTS_BLOCK_TITLE = 'VISHNU_JR_RESULTS_STORE';

const ALLOWED_ORIGINS = [
  'https://murthy-09.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(allowed => origin === allowed || origin.startsWith(allowed + ':'));
}

function corsHeaders(origin) {
  const allowedOrigin = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// -- Notion helpers --

async function notionFetch(path, token, options = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return res.json();
}

function extractPlainText(richTextArray) {
  if (!richTextArray) return '';
  return richTextArray.map(t => t.plain_text || '').join('');
}

function extractBlockText(blocks) {
  const lines = [];
  for (const block of blocks) {
    const type = block.type;
    if (type === 'bulleted_list_item' || type === 'numbered_list_item') {
      lines.push('- ' + extractPlainText(block[type].rich_text));
    } else if (block[type]?.rich_text) {
      lines.push(extractPlainText(block[type].rich_text));
    }
  }
  return lines.join('\n');
}

async function getAllBlocks(pageId, token) {
  let blocks = [];
  let cursor;
  do {
    const params = cursor ? `?start_cursor=${cursor}` : '';
    const data = await notionFetch(`/blocks/${pageId}/children${params}`, token);
    blocks = blocks.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return blocks;
}

// -- GET /knowledge --
// Fetches all child pages of the main Notion page, reads their blocks,
// and returns concatenated text content.

async function handleKnowledge(token) {
  // Get child blocks of main page to find sub-pages
  const blocks = await getAllBlocks(NOTION_PAGE_ID, token);

  const childPageIds = blocks
    .filter(b => b.type === 'child_page')
    .map(b => ({ id: b.id, title: b[b.type]?.title || 'Untitled' }));

  let content = '';
  const sectionTexts = await Promise.all(
    childPageIds.map(async (page) => {
      const pageBlocks = await getAllBlocks(page.id, token);
      const text = extractBlockText(pageBlocks);
      return `=== ${page.title} ===\n${text}`;
    })
  );

  content = sectionTexts.join('\n\n');

  return { content, updated: new Date().toISOString(), pages: childPageIds.length };
}

// -- POST /update --
// Appends a paragraph block to the main Notion page with session update text.

async function handleUpdate(body, token) {
  const { text } = body;
  if (!text) return { error: 'Missing text field' };

  const timestamp = new Date().toISOString();
  const updateText = `[Session Update ${timestamp}] ${text}`;

  await notionFetch(`/blocks/${NOTION_PAGE_ID}/children`, token, {
    method: 'PATCH',
    body: JSON.stringify({
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: updateText } }],
          },
        },
      ],
    }),
  });

  return { success: true, timestamp };
}

// -- POST /analyze --
// Proxies a request to the Anthropic Messages API.

async function handleAnalyze(body, apiKey) {
  const payload = JSON.stringify({
    model: body.model || 'claude-opus-4-6',
    max_tokens: body.max_tokens || 8000,
    system: body.system || '',
    messages: body.messages || [],
  });

  const delays = [0, 1000, 3000, 9000];
  let lastError = null;

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise(r => setTimeout(r, delays[attempt]));
    }

    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: payload,
    });

    if (res.ok) {
      return res.json();
    }

    // Retry on 429 (rate limit) or 500/502/503, fail fast on everything else
    // 524 is Cloudflare timeout -- retrying won't help
    if (res.status !== 429 && (res.status < 500 || res.status === 524)) {
      return res.json();
    }

    lastError = { status: res.status, message: `Anthropic API returned ${res.status}` };
  }

  return { error: { type: 'api_error', message: lastError.message + ' after 4 attempts' } };
}

// -- Results store helpers --
// Results are stored as a code block titled VISHNU_JR_RESULTS_STORE
// on the main Notion page. The code block language is "json" and
// its content is a JSON string of { results: [...], timestamp: "..." }.

async function findResultsBlock(token) {
  const blocks = await getAllBlocks(NOTION_PAGE_ID, token);
  for (const block of blocks) {
    if (block.type === 'code') {
      const caption = extractPlainText(block.code?.caption);
      if (caption === RESULTS_BLOCK_TITLE) {
        return block;
      }
    }
  }
  return null;
}

async function readResultsStore(token) {
  const block = await findResultsBlock(token);
  if (!block) return { results: [], timestamp: null };
  const raw = extractPlainText(block.code?.rich_text);
  try {
    return JSON.parse(raw);
  } catch {
    return { results: [], timestamp: null };
  }
}

async function writeResultsStore(data, token) {
  const block = await findResultsBlock(token);
  const jsonStr = JSON.stringify(data);

  // Notion rich_text has a 2000 char limit per element -- split if needed
  const chunks = [];
  for (let i = 0; i < jsonStr.length; i += 2000) {
    chunks.push({ type: 'text', text: { content: jsonStr.slice(i, i + 2000) } });
  }

  if (block) {
    // Update existing block
    await notionFetch(`/blocks/${block.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        code: {
          rich_text: chunks,
          language: 'json',
          caption: [{ type: 'text', text: { content: RESULTS_BLOCK_TITLE } }],
        },
      }),
    });
  } else {
    // Create new code block
    await notionFetch(`/blocks/${NOTION_PAGE_ID}/children`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        children: [
          {
            object: 'block',
            type: 'code',
            code: {
              rich_text: chunks,
              language: 'json',
              caption: [{ type: 'text', text: { content: RESULTS_BLOCK_TITLE } }],
            },
          },
        ],
      }),
    });
  }
}

// -- POST /save-result --
// Appends one result to the results store.

async function handleSaveResult(body, token) {
  const { result, timestamp } = body;
  if (!result) return { error: 'Missing result field' };

  const store = await readResultsStore(token);
  store.results.push(result);
  store.timestamp = timestamp || new Date().toISOString();
  await writeResultsStore(store, token);

  return { success: true, count: store.results.length };
}

// -- GET /get-results --
// Returns all saved results from the Notion store.

async function handleGetResults(token) {
  return await readResultsStore(token);
}

// -- POST /clear-results --
// Deletes the results store block from Notion.

async function handleClearResults(token) {
  const block = await findResultsBlock(token);
  if (block) {
    await notionFetch(`/blocks/${block.id}`, token, { method: 'DELETE' });
  }
  return { success: true };
}

// -- Router --

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('Origin') || '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      // GET /knowledge
      if (path === '/knowledge' && request.method === 'GET') {
        const data = await handleKnowledge(env.NOTION_TOKEN);
        return json(data, 200, origin);
      }

      // POST /update
      if (path === '/update' && request.method === 'POST') {
        const body = await request.json();
        const data = await handleUpdate(body, env.NOTION_TOKEN);
        return json(data, data.error ? 400 : 200, origin);
      }

      // POST /analyze
      if (path === '/analyze' && request.method === 'POST') {
        const body = await request.json();
        const data = await handleAnalyze(body, env.ANTHROPIC_KEY);
        return json(data, 200, origin);
      }

      // POST /save-result
      if (path === '/save-result' && request.method === 'POST') {
        const body = await request.json();
        const data = await handleSaveResult(body, env.NOTION_TOKEN);
        return json(data, data.error ? 400 : 200, origin);
      }

      // GET /get-results
      if (path === '/get-results' && request.method === 'GET') {
        const data = await handleGetResults(env.NOTION_TOKEN);
        return json(data, 200, origin);
      }

      // POST /clear-results
      if (path === '/clear-results' && request.method === 'POST') {
        const data = await handleClearResults(env.NOTION_TOKEN);
        return json(data, 200, origin);
      }

      return json({ error: 'Not found' }, 404, origin);
    } catch (err) {
      return json({ error: err.message || 'Internal error' }, 500, origin);
    }
  },
};
