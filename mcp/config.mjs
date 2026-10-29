import { fileURLToPath } from 'node:url';
const flags = process.argv.slice(2), options = {};
for (let i = 0; i < flags.length; i += 2) {
  if (!['--site-url', '--bridge-port'].includes(flags[i]) || !flags[i + 1]) throw new Error('Usage: node mcp/config.mjs [--site-url http://127.0.0.1:8899/] [--bridge-port 8900]');
  options[flags[i]] = flags[i + 1];
}
const site = new URL(options['--site-url'] || 'http://127.0.0.1:8899/'), port = Number(options['--bridge-port'] || 8900);
if (site.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(site.hostname) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a loopback HTTP site and a bridge port from 1024–65535.');
console.log(JSON.stringify({ mcpServers: { previzcam: { command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env: { PREVIZCAM_ALLOWED_ORIGINS: site.origin, PREVIZCAM_BRIDGE_PORT: String(port) } } } }, null, 2));
