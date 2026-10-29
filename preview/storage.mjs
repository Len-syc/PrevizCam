// Multi-project storage in IndexedDB. Keyed on project id ('lastActive' stores
// which archive was open). Version 2 migrates the legacy single 'active' entry.
let connection;
function db() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('previzcam-preview', 2);
    request.onupgradeneeded = async () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('projects')) database.createObjectStore('projects');
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  return connection;
}
function request_done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
export async function listProjects() {
  const database = await db(), store = database.transaction('projects', 'readonly').objectStore('projects');
  const entries = await request_done(store.getAll());
  return entries.filter(e => e?.id !== 'lastActive').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export async function loadProject(id) {
  const database = await db();
  return request_done(database.transaction('projects', 'readonly').objectStore('projects').get(id));
}
export async function saveProject(entry) {
  const database = await db(), transaction = database.transaction('projects', 'readwrite');
  transaction.objectStore('projects').put({ ...entry, updatedAt: Date.now() }, entry.id);
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(entry); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
}
export async function removeProject(id) {
  const database = await db(), transaction = database.transaction('projects', 'readwrite');
  transaction.objectStore('projects').delete(id);
  return new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
}
export async function loadActiveId() {
  const database = await db();
  // The record's own key is the literal 'lastActive'; the project id lives in activeId.
  return (await request_done(database.transaction('projects', 'readonly').objectStore('projects').get('lastActive')))?.activeId || null;
}
export async function saveActiveId(id) {
  const database = await db(), transaction = database.transaction('projects', 'readwrite');
  transaction.objectStore('projects').put({ id: 'lastActive', activeId: id, updatedAt: Date.now() }, 'lastActive');
  return new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
}
export async function migrateLegacyWorkspace() {
  const database = await db();
  if (!database.objectStoreNames.contains('workspace')) return null;
  const legacy = await request_done(database.transaction('workspace', 'readonly').objectStore('workspace').get('active'));
  if (!legacy?.project) return null;
  const id = legacy.project.id || crypto.randomUUID();
  await saveProject({ id, project: legacy.project, modelBytes: legacy.modelBytes || null });
  await saveActiveId(id);
  const transaction = database.transaction('workspace', 'readwrite');
  transaction.objectStore('workspace').clear();
  return id;
}
export function download(data, filename, type = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data, null, 2)], { type });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function toBase64(bytes) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(new Blob([bytes])); });
}
export function fromBase64(value) {
  if (typeof value !== 'string' || value.length > 140000000) throw new Error('内嵌模型无效或超过 100 MB。');
  return Uint8Array.from(atob(value), c => c.charCodeAt(0)).buffer;
}
