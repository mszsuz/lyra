// Test WS: show raw response data from bridge
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:8768');

ws.on('open', () => {
    console.log('Connected');
    const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: "Say hello in Russian, just one word" }
    });
    console.log('Sending:', msg.length, 'bytes');
    ws.send(msg);
});

ws.on('message', (data) => {
    const text = data.toString();
    console.log('\n=== RAW RESPONSE ===');
    console.log('Total bytes:', text.length);
    console.log('Type:', typeof text);

    // Show first 2000 chars
    console.log('\n--- Content (first 2000 chars) ---');
    console.log(text.substring(0, 2000));

    // Show line separators
    const lines = text.split('\n');
    console.log('\n--- Lines (split by \\n) ---');
    console.log('Line count:', lines.length);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
            const obj = JSON.parse(line);
            console.log(`Line ${i}: type=${obj.type}, length=${line.length}`);
            if (obj.type === 'assistant' && obj.message?.content) {
                for (const block of obj.message.content) {
                    if (block.type === 'text') {
                        console.log(`  TEXT: "${block.text.substring(0, 200)}"`);
                    } else if (block.type === 'tool_use') {
                        console.log(`  TOOL: ${block.name}`);
                    }
                }
            }
            if (obj.type === 'result') {
                console.log(`  RESULT: "${obj.result}"`);
            }
        } catch(e) {
            console.log(`Line ${i}: PARSE ERROR - "${line.substring(0, 100)}"`);
        }
    }

    ws.close();
});

ws.on('error', (err) => console.error('Error:', err.message));
ws.on('close', () => { console.log('\nDone'); process.exit(0); });

setTimeout(() => { console.log('Timeout'); ws.close(); process.exit(1); }, 120000);
