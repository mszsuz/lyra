// Test WebSocket communication with stdio-bridge — full output
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:8768');
let messageCount = 0;

ws.on('open', () => {
    console.log('Connected to bridge');
    const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: "Say hello in one word" }
    });
    ws.send(msg);
    console.log('Sent:', msg);
});

ws.on('message', (data) => {
    messageCount++;
    const text = data.toString();
    console.log(`\n=== Message #${messageCount} (${text.length} bytes) ===`);
    // Show FULL output
    console.log(text);
    console.log('=== End ===');

    // Parse NDJSON lines and show types
    const lines = text.split('\n').filter(l => l.trim());
    console.log(`  Contains ${lines.length} JSON lines:`);
    for (let i = 0; i < lines.length; i++) {
        try {
            const obj = JSON.parse(lines[i]);
            console.log(`  Line ${i+1}: type=${obj.type} subtype=${obj.subtype || ''} ${obj.result ? 'result=' + obj.result : ''}`);
        } catch(e) {
            console.log(`  Line ${i+1}: [parse error] ${lines[i].substring(0, 100)}`);
        }
    }
});

ws.on('error', (err) => {
    console.error('WS Error:', err.message);
});

ws.on('close', (code, reason) => {
    console.log(`Connection closed: code=${code} reason=${reason}`);
    process.exit(0);
});

// Timeout after 120 seconds
setTimeout(() => {
    console.log(`Timeout after 120s. Received ${messageCount} messages.`);
    ws.close();
    process.exit(messageCount > 0 ? 0 : 1);
}, 120000);
