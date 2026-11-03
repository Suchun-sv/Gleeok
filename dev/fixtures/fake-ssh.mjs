#!/usr/bin/env node
// A stand-in for ssh in dev/code-tunnel.json: forwards `-L 127.0.0.1:L:127.0.0.1:R` locally after a
// short wait (so the 正在连接 page shows), fails for host "bad-host", and hands "real-…" hosts to the
// real ssh (with the prefix taken off) so its own complaints can be seen.
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
const args = process.argv.slice(2);
const host = args[args.length - 1];
if (host.startsWith('real-')) {
  const child = spawn('/usr/bin/ssh', [...args.slice(0, -1), host.slice(5)], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
} else if (host === 'bad-host') {
  console.error('ssh: connect to host bad-host port 22: Connection refused');
  process.exit(255);
} else {
  const [bind, local, rhost, remote] = args[args.indexOf('-L') + 1].split(':');
  setTimeout(() => {
    createServer((c) => {
      const u = connect(Number(remote), rhost);
      c.pipe(u).pipe(c);
      u.on('error', () => c.destroy());
      c.on('error', () => u.destroy());
    }).listen(Number(local), bind);
  }, 1500);
}
