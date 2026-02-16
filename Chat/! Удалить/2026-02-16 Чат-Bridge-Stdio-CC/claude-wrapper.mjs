// Wrapper: clears CLAUDECODE env var and spawns claude with all args
// This allows nested Claude Code sessions from within a Claude Code context
import { spawn } from 'child_process';

delete process.env.CLAUDECODE;

const child = spawn('claude', process.argv.slice(2), {
    stdio: 'inherit',
    env: process.env,
    shell: false
});

child.on('exit', (code) => {
    process.exit(code || 0);
});
