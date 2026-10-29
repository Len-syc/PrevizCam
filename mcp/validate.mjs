import { readFile } from 'node:fs/promises';
import { validateProject } from '../preview/core.mjs';

// Standalone project validation, so a saved/exported project can be checked
// outside a browser (CI, or an agent sanity-checking JSON before a draft).
//
// Usage:  node mcp/validate.mjs < project.json
//         node mcp/validate.mjs path/to/project.json
// Exit code 0 = valid, 1 = invalid (message on stderr).
let source = '';
try {
  source = process.argv[2] ? await readFile(process.argv[2], 'utf8') : await readStdin();
  const project = JSON.parse(source);
  validateProject(project);
  const summary = {
    valid: true,
    name: project.name,
    sceneId: project.scene.id,
    cameras: project.cameras.length,
    actors: project.actors.length,
    shots: project.shots.length,
    totalSeconds: Math.round(project.shots.reduce((sum, shot) => sum + shot.duration, 0) * 1000) / 1000,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof SyntaxError ? `JSON 解析失败：${error.message}` : error.message}\n`);
  process.exitCode = 1;
}

async function readStdin() {
  if (process.stdin.isTTY) throw new Error('需要项目 JSON：用管道传入，或把文件路径作为第一个参数。');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}
