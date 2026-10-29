import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class ArtifactStore {
  constructor(directory) { this.directory = resolve(directory); }
  async save(files, metadata) {
    if (!Array.isArray(files) || !files.length || files.length > 320) throw new Error('Invalid artifact collection');
    const seen = new Set(); let bytes = 0;
    const prepared = files.map(file => {
      if (typeof file.name !== 'string' || basename(file.name) !== file.name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(file.name) || seen.has(file.name) || file.name === 'manifest.json') throw new Error('Invalid or duplicate artifact name');
      if (typeof file.data !== 'string' || file.data.length > 200 * 1024 * 1024 || file.data.length % 4 || /[^A-Za-z0-9+/]/.test(file.data.replace(/={1,2}$/, ''))) throw new Error('Invalid artifact encoding');
      const buffer = Buffer.from(file.data, 'base64'); bytes += buffer.length;
      if (bytes > 150 * 1024 * 1024) throw new Error('Artifact package exceeds 150 MB');
      seen.add(file.name); return { ...file, buffer };
    });
    await mkdir(this.directory, { recursive: true });
    const key = randomUUID(), staging = join(this.directory, `.pending-${key}`), destination = join(this.directory, key);
    await mkdir(staging);
    try {
      const artifacts = [];
      for (const file of prepared) {
        await writeFile(join(staging, file.name), file.buffer, { flag: 'wx' });
        artifacts.push({ name: file.name, mimeType: file.mimeType, path: join(destination, file.name), bytes: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex') });
      }
      const manifest = { type: 'previzcam.artifacts', version: 1, ...metadata, artifacts, createdAt: new Date().toISOString() };
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await rename(staging, destination);
      return { artifacts, manifestPath: join(destination, 'manifest.json') };
    } catch (error) {
      // Only this freshly-created, UUID-named staging directory is removed.
      await rm(staging, { recursive: true, force: true }); throw error;
    }
  }
}
