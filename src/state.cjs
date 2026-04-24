const fs = require('fs');
const path = require('path');
const { STATE_FILE_PATH } = require('./config.cjs');

const responseOverrides = {};
const aiRemovedFields = {};
const scenarioStore = {};

const workspaces = {};
const variableMockStore = {};
const proxyUrls = {};
let upstreamUrl = null;

// Maps service name -> workspace ID (null = global/pre-existing, visible only in Default)
const serviceRegistry = {};
let registrySeeded = false;

// ── Persistence ────────────────────────────────────────────────
// Debounced write-to-disk. Collects rapid mutations into a single I/O.
let saveTimer = null;
const SAVE_DELAY_MS = 2000;

function persistEnabled() {
  return Boolean(STATE_FILE_PATH);
}

function getSnapshot() {
  return {
    workspaces,
    scenarioStore,
    responseOverrides,
    variableMockStore,
    serviceRegistry,
    upstreamUrl,
    savedAt: new Date().toISOString(),
  };
}

function scheduleSave() {
  if (!persistEnabled()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const dir = path.dirname(STATE_FILE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = STATE_FILE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(getSnapshot(), null, 2), 'utf-8');
      fs.renameSync(tmp, STATE_FILE_PATH);
    } catch (err) {
      console.log(`  ⚠ State save failed: ${err.message}`);
    }
  }, SAVE_DELAY_MS);
}

function loadFromDisk() {
  if (!persistEnabled()) return;
  try {
    if (!fs.existsSync(STATE_FILE_PATH)) return;
    const raw = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
    const data = JSON.parse(raw);

    if (data.workspaces) Object.assign(workspaces, data.workspaces);
    if (data.scenarioStore) Object.assign(scenarioStore, data.scenarioStore);
    if (data.responseOverrides) Object.assign(responseOverrides, data.responseOverrides);
    if (data.variableMockStore) Object.assign(variableMockStore, data.variableMockStore);
    if (data.serviceRegistry) Object.assign(serviceRegistry, data.serviceRegistry);
    if (data.upstreamUrl) upstreamUrl = data.upstreamUrl;

    const wsCount = Object.keys(workspaces).length;
    const scCount = Object.keys(scenarioStore).length;
    console.log(`  State: restored from ${STATE_FILE_PATH} (${wsCount} workspaces, ${scCount} scenarios, saved ${data.savedAt || 'unknown'})`);
  } catch (err) {
    console.log(`  ⚠ State load failed: ${err.message}`);
  }
}

// Load persisted state on module init
loadFromDisk();

// ── Core functions ─────────────────────────────────────────────

function getUserScope(req) {
  return req.headers['x-user'] || 'global';
}

function getWorkspaceId(req) {
  return req.headers['x-workspace'] || null;
}

function getEffectiveScope(req) {
  const wsId = getWorkspaceId(req);
  const user = getUserScope(req);
  return wsId ? `ws:${wsId}:${user}` : user;
}

function registerService(serviceName, workspaceId) {
  serviceRegistry[serviceName] = workspaceId || null;
  scheduleSave();
}

function seedRegistryFromMicrocks(serviceNames) {
  if (registrySeeded) return;
  for (const name of serviceNames) {
    if (!(name in serviceRegistry)) {
      serviceRegistry[name] = null;
    }
  }
  registrySeeded = true;
}

function isServiceVisibleInWorkspace(serviceName, workspaceId) {
  const owner = serviceRegistry[serviceName];
  if (owner === undefined) return true;
  if (!workspaceId) return owner === null;
  return owner === workspaceId;
}

function getServicesForWorkspace(workspaceId) {
  const visible = new Set();
  for (const [name, owner] of Object.entries(serviceRegistry)) {
    if (!workspaceId && owner === null) visible.add(name);
    else if (workspaceId && owner === workspaceId) visible.add(name);
  }
  return visible;
}

function unregisterWorkspaceServices(workspaceId, moveToGlobal) {
  for (const [name, owner] of Object.entries(serviceRegistry)) {
    if (owner === workspaceId) {
      if (moveToGlobal) {
        serviceRegistry[name] = null;
      } else {
        delete serviceRegistry[name];
      }
    }
  }
  scheduleSave();
}

// Notify persistence layer that state changed. Call after modifying
// any of the exported objects (scenarioStore, responseOverrides, etc.)
// from routes. Workspace/service registration calls this automatically.
function markDirty() {
  scheduleSave();
}

module.exports = {
  responseOverrides,
  aiRemovedFields,
  scenarioStore,
  workspaces,
  variableMockStore,
  proxyUrls,
  serviceRegistry,
  get upstreamUrl() { return upstreamUrl; },
  set upstreamUrl(v) { upstreamUrl = v; scheduleSave(); },
  getUserScope,
  getWorkspaceId,
  getEffectiveScope,
  registerService,
  seedRegistryFromMicrocks,
  isServiceVisibleInWorkspace,
  getServicesForWorkspace,
  unregisterWorkspaceServices,
  markDirty,
};
