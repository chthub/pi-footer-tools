import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { readStoredCredential, type CreateModelRuntimeOptions, type ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { AccountProfile } from "./config.ts";

type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
export const PROVIDER = "openai-codex";
const STATE_KEY = Symbol.for("pi-footer-tools.account-switch.routing.v1");

interface RuntimeCredentials {
  store: CredentialStore;
  hasRuntimeApiKey(provider: string): boolean;
  removeRuntimeApiKey?(provider: string): void;
  [STATE_KEY]?: RoutingState;
}
export interface AccountSelection {
  name: string;
  authPath: string;
}
interface RoutingState {
  base: CredentialStore;
  selected: CredentialStore;
  selectedPath: string;
  name: string;
  route: CredentialStore;
  owner?: object;
  pending?: { owner: object; selected: CredentialStore; selectedPath: string; name: string };
}

/** Never let a new runtime adopt an uncommitted selection from an older owner. */
function rollbackPending(state: RoutingState) {
  if (!state.pending) return;
  const previous = state.pending;
  state.selected = previous.selected;
  state.selectedPath = previous.selectedPath;
  state.name = previous.name;
  state.pending = undefined;
}

function isStore(value: unknown): value is CredentialStore {
  if (typeof value !== "object" || value === null) return false;
  const store = value as Partial<CredentialStore>;
  return [store.read, store.modify, store.delete, store.list].every(fn => typeof fn === "function");
}

/**
 * Pi 1.1 exposes credential creation but NOT live credential-store replacement.
 * Keep the single version-sensitive bridge here, guard its shape, and fail closed.
 * Do not copy tokens or patch authentication/stream methods: Pi retains its own
 * cross-process OAuth refresh lock and persists refresh/login to the selected file.
 */
function runtimeCredentials(registry: ModelRegistry, allowOverride = false): RuntimeCredentials {
  const runtime = (registry as unknown as { runtime?: { credentials?: unknown } }).runtime;
  const value = runtime?.credentials;
  if (typeof value !== "object" || value === null) throw new Error("unsupported-runtime");
  const credentials = value as RuntimeCredentials;
  if (!isStore(credentials.store) || typeof credentials.hasRuntimeApiKey !== "function") throw new Error("unsupported-runtime");
  if (!allowOverride && credentials.hasRuntimeApiKey(PROVIDER)) throw new Error("runtime-api-key");
  return credentials;
}

function canonical(path: string) {
  try { return realpathSync(path); } catch { return resolve(path); }
}
export function accountPath(profile: AccountProfile) {
  return join(profile.agentDir, "auth.json");
}
export function accountName(agentDir: string, accounts: readonly AccountProfile[]): string {
  const current = canonical(join(agentDir, "auth.json"));
  return accounts.find(profile => canonical(accountPath(profile)) === current)?.name
    ?? basename(agentDir).replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
}

/** No tokens leave this controller; only profile labels reach the UI. */
export function attachRouting(registry: ModelRegistry, agentDir: string, accounts: readonly AccountProfile[]) {
  const credentials = runtimeCredentials(registry);
  const owner = {};
  let state = credentials[STATE_KEY];
  if (state && credentials.store !== state.base && credentials.store !== state.route) throw new Error("store-changed");
  if (!state) {
    const base = credentials.store;
    const authPath = (base as unknown as { authPath?: string }).authPath;
    // These callbacks run only after state has been fully initialized.
    const selectedStore = () => state!.selected;
    // Snapshot the chosen store at operation entry so in-flight refreshes stay
    // attached to the account they started with, even across session shutdown.
    const route: CredentialStore = {
      read: (provider, options) => (provider === PROVIDER ? selectedStore() : base).read(provider, options),
      modify: (provider, fn, options) => (provider === PROVIDER ? selectedStore() : base).modify(provider, fn, options),
      delete: (provider, options) => (provider === PROVIDER ? selectedStore() : base).delete(provider, options),
      list: async options => {
        const selected = selectedStore();
        if (selected === base) return base.list(options);
        const [original, chosen] = await Promise.all([base.list(options), selected.list(options)]);
        return [...original.filter(entry => entry.providerId !== PROVIDER), ...chosen.filter(entry => entry.providerId === PROVIDER)];
      },
    };
    state = {
      base, selected: base, route, selectedPath: authPath ?? join(agentDir, "auth.json"),
      name: accountName(authPath ? dirname(authPath) : agentDir, accounts),
    };
    credentials[STATE_KEY] = state;
  }
  const current = state;
  rollbackPending(current);
  // An ordinary reload may adopt state created by the previous extension version.
  current.selectedPath ??= (current.selected as unknown as { authPath?: string }).authPath ?? join(agentDir, "auth.json");
  const factory = current.base.constructor as unknown as { create?: (path: string) => CredentialStore };
  if (typeof factory.create !== "function") throw new Error("unsupported-storage");
  current.owner = owner;
  credentials.store = current.route;

  return {
    get name() { return credentials.hasRuntimeApiKey(PROVIDER) ? "runtime-key" : current.name; },
    get selection(): AccountSelection { return { name: current.name, authPath: current.selectedPath }; },
    async switchTo(name: string, canCommit = () => true, publish?: (selection: AccountSelection) => void) {
      if (credentials.store !== current.route || current.owner !== owner || current.pending) throw new Error("store-changed");
      if (credentials.hasRuntimeApiKey(PROVIDER)) throw new Error("runtime-api-key");
      const profile = accounts.find(value => value.name === name);
      if (!profile) throw new Error("unknown-account");
      const path = accountPath(profile);
      // Do not create auth files/directories for an account which has never logged in.
      if (readStoredCredential(PROVIDER, path)?.type !== "oauth") throw new Error("missing-oauth");
      const target = factory.create!(path);
      if (!isStore(target)) throw new Error("unsupported-storage");
      const credential = await target.read(PROVIDER);
      // A label without valid stored ChatGPT credentials must never be selected.
      if (credential?.type !== "oauth" || typeof credential.access !== "string" || !credential.access
        || typeof credential.refresh !== "string" || !credential.refresh
        || !Number.isFinite(credential.expires) || credential.expires <= 0
        || typeof credential.accountId !== "string" || !credential.accountId) throw new Error("missing-oauth");
      if (!canCommit() || credentials.store !== current.route || current.owner !== owner) throw new Error("session-changed");
      const transaction = { owner, selected: current.selected, name: current.name, selectedPath: current.selectedPath };
      current.pending = transaction;
      current.selected = target;
      current.selectedPath = path;
      current.name = name;
      try {
        const result = await registry.refresh({ allowNetwork: false, providers: [PROVIDER] });
        if (result.aborted || result.errors.size || !canCommit()
          || credentials.store !== current.route || current.owner !== owner) throw new Error("refresh-failed");
        // Publish last: a failed atomic channel write must roll back the main route too.
        publish?.({ name, authPath: path });
        current.pending = undefined;
      } catch {
        if (current.pending === transaction) {
          rollbackPending(current);
          // A stale owner must not roll back a newer runtime's committed route.
          await registry.refresh({ allowNetwork: false, providers: [PROVIDER] }).catch(() => {});
        }
        throw new Error("refresh-failed");
      }
    },
    detach(preserveForReload = false) {
      if (current.owner !== owner) return;
      rollbackPending(current);
      if (credentials.store === current.route) credentials.store = current.base;
      current.owner = undefined;
      if (!preserveForReload) delete credentials[STATE_KEY];
    },
  };
}

/**
 * A child resolves the parent's current selection at each credential operation.
 * Capture a concrete store BEFORE entering it: an OAuth refresh holds that
 * store's file lock and writes back there even if the parent switches meanwhile.
 * In-flight HTTP requests already have their token and are never restarted.
 */
export function attachFollowingRouting(registry: ModelRegistry, follow: () => AccountSelection) {
  const credentials = runtimeCredentials(registry, true);
  const base = credentials.store;
  // Install denial BEFORE validating the channel/factory. Pi logs lifecycle
  // errors and defers shutdown, so leaving launch credentials active is unsafe.
  const deny = () => { throw new Error("Codex account synchronization unavailable; reload the parent window."); };
  credentials.store = {
    read: (provider, options) => provider === PROVIDER ? deny() : base.read(provider, options),
    modify: (provider, fn, options) => provider === PROVIDER ? deny() : base.modify(provider, fn, options),
    delete: (provider, options) => provider === PROVIDER ? deny() : base.delete(provider, options),
    list: async options => (await base.list(options)).filter(entry => entry.providerId !== PROVIDER),
  };
  if (credentials.hasRuntimeApiKey(PROVIDER)) {
    credentials.removeRuntimeApiKey?.(PROVIDER);
    throw new Error("runtime-api-key");
  }
  const factory = base.constructor as unknown as { create?: (path: string) => CredentialStore };
  if (typeof factory.create !== "function") throw new Error("unsupported-storage");
  let cached: { path: string; store: CredentialStore } | undefined;
  const chosen = () => {
    if (credentials.hasRuntimeApiKey(PROVIDER)) throw new Error("runtime-api-key");
    const { authPath } = follow();
    if (cached?.path !== authPath) {
      const store = factory.create!(authPath);
      if (!isStore(store)) throw new Error("unsupported-storage");
      cached = { path: authPath, store };
    }
    return cached.store;
  };
  chosen(); // Refuse to attach to an invalid or missing parent channel.
  const route: CredentialStore = {
    read: (provider, options) => (provider === PROVIDER ? chosen() : base).read(provider, options),
    modify: (provider, fn, options) => (provider === PROVIDER ? chosen() : base).modify(provider, fn, options),
    delete: (provider, options) => (provider === PROVIDER ? chosen() : base).delete(provider, options),
    list: async options => {
      const selected = chosen();
      const [original, entries] = await Promise.all([base.list(options), selected.list(options)]);
      return [...original.filter(entry => entry.providerId !== PROVIDER), ...entries.filter(entry => entry.providerId === PROVIDER)];
    },
  };
  credentials.store = route;
  return { detach() { if (credentials.store === route) credentials.store = base; } };
}
