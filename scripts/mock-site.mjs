import http from 'node:http';

const port = Number(process.env.MOCK_PORT ?? 9099);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usageOf = (prompt, completion) => ({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion });

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch {}
  const url = new URL(req.url ?? '/', 'http://localhost');
  res.setHeader('access-control-allow-origin', '*');

  if (url.pathname === '/api/chat') {
    if (process.env.MOCK_REQUIRE_COOKIE === '1' && !req.headers.cookie) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const prompt = JSON.stringify(body.messages?.at?.(-1)?.content ?? body.message ?? '').slice(0, 80);
    const answer = 'mock answer for: ' + prompt;
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const piece of ['Hello', ' from', ' mock-site.']) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }], model: 'mock-1' }) + '\n\n');
        await sleep(25);
      }
      if (body.stream_options?.include_usage) {
        res.write('data: ' + JSON.stringify({ choices: [], usage: usageOf(11, 7) }) + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: answer } }],
      model: body.model ?? 'mock-1',
      usage: usageOf(9, 13)
    }));
    return;
  }

  if (url.pathname === '/api/anthropic-style') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      content: [{ type: 'text', text: 'anthropic style answer' }],
      usage: { input_tokens: 21, output_tokens: 34 }
    }));
    return;
  }

  if (url.pathname === '/api/plain') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('plain text answer from mock');
    return;
  }

  if (url.pathname === '/api/limited') {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'quota insufficient' }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
server.listen(port, '127.0.0.1', () => console.log('mock site on ' + port));
