// Safe compatibility entry point. The suite owns only disposable temp files.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const child = spawn(process.execPath, ['--test', fileURLToPath(new URL('./relay.test.js', import.meta.url))], { stdio: 'inherit' });
child.once('error', () => { process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
