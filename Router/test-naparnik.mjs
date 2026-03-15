#!/usr/bin/env node
// Test Naparnik API — see raw SSE format with tool_calls loop

const TOKEN = 'e0mdX1966V3UlvSBeqe_-AcJJCDzAmvWh6MhEO6DomA';
const BASE = 'https://code.1c.ai';
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Authorization': TOKEN,
  'Origin': 'https://code.1c.ai',
  'Referer': 'https://code.1c.ai/chat/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

async function run() {
  // 1. Create conversation
  let res = await fetch(BASE + '/chat_api/v1/conversations/', {
    method: 'POST',
    headers: { ...headers, 'Session-Id': '' },
    body: JSON.stringify({ skill_name: 'custom', is_chat: true, ui_language: 'russian', programming_language: '1c' })
  });
  const conv = await res.json();
  console.log('Conv:', conv.uuid);

  // 2. Send question
  const msgUrl = BASE + '/chat_api/v1/conversations/' + conv.uuid + '/messages';
  let payload = {
    role: 'user',
    content: { content: { instruction: 'Как подключить механизм характеристик из БСП к произвольному справочнику? Какие шаги нужно выполнить?' }, tools: [] },
    parent_uuid: null
  };

  for (let round = 0; round < 15; round++) {
    console.log(`\n=== ROUND ${round} ===`);
    res = await fetch(msgUrl, {
      method: 'POST',
      headers: { ...headers, 'Accept': 'text/event-stream' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    const lines = text.split('\n');
    let lineNum = 0;
    let msgUuid = '';
    let fullText = '';
    let chunks = [];
    let toolCalls = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      if (!line.startsWith('data:')) continue;
      const dataStr = line.substring(5).trim();
      if (dataStr === '[DONE]') { console.log('--- [DONE] ---'); break; }
      try {
        lineNum++;
        const d = JSON.parse(dataStr);

        const info = {};
        if (d.role) info.role = d.role;
        if (d.finished != null) info.finished = d.finished;
        if (d.uuid) info.uuid = d.uuid.substring(0, 8);

        if (d.content && typeof d.content === 'object') {
          if (d.content.content) {
            info.content_content = d.content.content.substring(0, 150);
            fullText = d.content.content;
          }
          if (d.content.tool_calls && d.content.tool_calls.length > 0) {
            info.tool_calls = d.content.tool_calls.map(tc => ({
              id: tc.id?.substring(0, 12),
              name: (tc.function || {}).name,
            }));
            if (d.finished) toolCalls = d.content.tool_calls;
          }
        }

        if (d.content_delta) {
          if (d.content_delta.content) {
            info.delta = d.content_delta.content.substring(0, 100);
            chunks.push(d.content_delta.content);
          }
          if (d.content_delta.reasoning_content) {
            info.reasoning = d.content_delta.reasoning_content.substring(0, 60);
          }
        }

        if (d.role === 'assistant' && d.uuid) {
          msgUuid = d.uuid;
        }

        if (Object.keys(info).length > 0) {
          console.log(`  L${lineNum}:`, JSON.stringify(info));
        }
      } catch (e) {
        console.log(`  L${lineNum} PARSE ERROR:`, line.substring(0, 200));
      }
    }

    const resultText = fullText || chunks.join('');
    console.log(`\n  SUMMARY: text=${resultText.length} chars, chunks=${chunks.length}, toolCalls=${toolCalls.length}, uuid=${msgUuid?.substring(0, 8)}`);
    if (resultText) console.log(`  TEXT (first 300): ${resultText.substring(0, 300)}`);

    if (toolCalls.length === 0) {
      console.log('  NO TOOL CALLS — done');
      break;
    }

    console.log(`  TOOL CALLS: ${toolCalls.map(tc => (tc.function || {}).name).join(', ')}`);
    const toolContent = toolCalls.map(tc => ({
      content: JSON.stringify({ id: tc.id, type: tc.type || 'function', function: tc.function }),
      name: (tc.function || {}).name || '',
      tool_call_id: tc.id
    }));
    payload = {
      role: 'tool',
      content: toolContent,
      parent_uuid: msgUuid
    };
  }
}

run().catch(e => console.error(e));
