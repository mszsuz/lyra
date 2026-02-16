// Test WebSocket communication with stdio-bridge
// Using 'ws' npm package instead of Node built-in WebSocket
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
    // Show first 2000 chars
    console.log(text.substring(0, 2000));
    if (text.length > 2000) console.log(`... (${text.length - 2000} more bytes)`);
    console.log('=== End ===');
});

ws.on('error', (err) => {
    console.error('WS Error:', err.message);
});

ws.on('close', (code, reason) => {
    console.log(`Connection closed: code=${code} reason=${reason}`);
    process.exit(0);
});

// Timeout after 90 seconds
setTimeout(() => {
    console.log(`Timeout after 90s. Received ${messageCount} messages.`);
    ws.close();
    process.exit(messageCount > 0 ? 0 : 1);
}, 90000);
