// Test multi-turn WebSocket communication with stdio-bridge
// Sends 2 messages: "Say hello" then "What did you just say?"
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:8768');
let messageCount = 0;
let turnCount = 0;

function parseNDJSON(text) {
    const lines = text.split('\n').filter(l => l.trim());
    const parsed = [];
    for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch(e) {}
    }
    return parsed;
}

ws.on('open', () => {
    console.log('Connected to bridge');
    // Send first message
    const msg1 = JSON.stringify({
        type: "user",
        message: { role: "user", content: "Say hello in Russian, just one word" }
    });
    ws.send(msg1);
    console.log('\n--- Turn 1 sent ---');
});

ws.on('message', (data) => {
    messageCount++;
    const text = data.toString();
    const objects = parseNDJSON(text);

    console.log(`\n=== WS Message #${messageCount} (${text.length} bytes, ${objects.length} JSON objects) ===`);

    for (const obj of objects) {
        if (obj.type === 'system') {
            console.log(`  [system] init, session=${obj.session_id?.substring(0, 8)}...`);
        } else if (obj.type === 'assistant') {
            const content = obj.message?.content || [];
            for (const block of content) {
                if (block.type === 'text') {
                    console.log(`  [assistant] TEXT: "${block.text}"`);
                } else if (block.type === 'tool_use') {
                    console.log(`  [assistant] TOOL_USE: ${block.name} id=${block.id}`);
                }
            }
        } else if (obj.type === 'result') {
            turnCount++;
            console.log(`  [result] "${obj.result}" (${obj.duration_ms}ms, cost=$${obj.total_cost_usd?.toFixed(4)})`);

            if (turnCount === 1) {
                // Send second message after first result
                console.log('\n--- Turn 2 sent ---');
                const msg2 = JSON.stringify({
                    type: "user",
                    message: { role: "user", content: "What did you just say? Repeat it." }
                });
                ws.send(msg2);
            } else if (turnCount >= 2) {
                console.log('\n✅ Multi-turn test PASSED! Both turns completed.');
                ws.close();
            }
        }
    }
});

ws.on('error', (err) => {
    console.error('WS Error:', err.message);
});

ws.on('close', (code, reason) => {
    console.log(`\nConnection closed: code=${code}. Total messages: ${messageCount}, turns: ${turnCount}`);
    process.exit(turnCount >= 2 ? 0 : 1);
});

// Timeout after 180 seconds
setTimeout(() => {
    console.log(`\nTimeout 180s. Messages: ${messageCount}, turns: ${turnCount}`);
    ws.close();
    process.exit(1);
}, 180000);
