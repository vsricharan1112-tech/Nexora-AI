'use strict';

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, options = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('https://generativelanguage.googleapis.com/')) return originalFetch(input, options);

  const headers = options.headers || {};
  const request = JSON.parse(options.body || '{}');
  const contents = request.contents || [];
  const valid = headers['x-goog-api-key'] === 'test-only-gemini-key'
    && url.endsWith('/models/gemini-3.5-flash-lite:generateContent')
    && request.systemInstruction?.parts?.length > 0
    && contents.length === 12
    && contents[0].role === 'model'
    && contents[0].parts?.[0]?.text === 'message-1'
    && contents[11].role === 'user'
    && contents[11].parts?.[0]?.text === 'message-12';
  if (!valid) return new Response(JSON.stringify({ error: { message: 'Unexpected Gemini request from test' } }), { status: 400 });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Mock Gemini answer' }] } }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};
