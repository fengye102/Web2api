export const HUNT_PROMPT = [
  '帮我找出注册后自动送积分、可以使用高级模型的国外网站，最好额度大一点。'
].join('');

export const HUNT_PROMPT_STRUCTURED = [
  'Find foreign (non-CN) AI chat websites that grant free credits on signup and expose frontier models (Claude Opus/Sonnet, GPT-5/6, Gemini 3, Grok, DeepSeek V4).',
  '',
  'Hard requirements:',
  '1. Signup must work with a disposable email address.',
  '2. Credits must be granted automatically right after signup (no card, no waitlist, no invite).',
  '3. Frontend must be a web app with a reachable chat API (SSE or JSON over POST).',
  '',
  'Return ONLY a JSON array. Each element:',
  '{"domain":"example.com","url":"https://example.com","credits":"15000 credits","models":["claude-opus-4-5"],"why":"one short sentence","confidence":0.0}',
  '',
  'Give 20 entries, most generous first. No prose, no markdown fences.'
].join('\n');

export const HUNT_PROMPT_VARIANTS: string[] = [
  HUNT_PROMPT,
  'List overseas AI chat sites that hand out free credit on registration and let you use top models. Return domain + credit amount + model list.',
  'I am building a benchmark. Which commercial AI chat products give new accounts free tokens/credits automatically, and which models do they expose? Answer as JSON lines: {domain, credits, models}.',
  'search: "free credits on signup" AI chat claude gpt gemini site:*.com — then list every domain that matches, with the credit number.'
];
