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
  [STATE_KEY]?: RoutingState;
}
interface RoutingState {
  base: CredentialStore;
  selected: CredentialStore;
  name: string;
  route: CredentialStore;
  owner?: object;
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
function runtimeCredentials(registry: ModelRegistry): RuntimeCredentials {
  const runtime = (registry as unknown as { runtime?: { credentials?: unknown } }).runtime;
  const value = runtime?.credentials;
  if (typeof value !== "object" || value === null) throw new Error("unsupported-runtime");
  const credentials = value as RuntimeCredentials;
  if (!isStore(credentials.store) || typeof credentials.hasRuntimeApiKey !== "function") throw new Error("unsupported-runtime");
  if (credentials.hasRuntimeApiKey(PROVIDER)) throw new Error("runtime-api-key");
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
      base, selected: base, route,
      name: accountName(authPath ? dirname(authPath) : agentDir, accounts),
    };
    credentials[STATE_KEY] = state;
  }
  const current = state;
  const factory = current.base.constructor as unknown as { create?: (path: string) => CredentialStore };
  if (typeof factory.create !== "function") throw new Error("unsupported-storage");
  current.owner = owner;
  credentials.store = current.route;

  return {
    get name() { return credentials.hasRuntimeApiKey(PROVIDER) ? "runtime-key" : current.name; },
    async switchTo(name: string, canCommit = () => true) {
      if (credentials.store !== current.route || current.owner !== owner) throw new Error("store-changed");
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
      const previous = { selected: current.selected, name: current.name };
      current.selected = target;
      current.name = name;
      try {
        const result = await registry.refresh({ allowNetwork: false, providers: [PROVIDER] });
        if (result.aborted || result.errors.size) throw new Error("refresh-failed");
      } catch {
        current.selected = previous.selected;
        current.name = previous.name;
        // Restore the auth/model snapshot too; do not expose raw provider errors.
        await registry.refresh({ allowNetwork: false, providers: [PROVIDER] }).catch(() => {});
        throw new Error("refresh-failed");
      }
    },
    detach(preserveForReload = false) {
      if (current.owner !== owner) return;
      if (credentials.store === current.route) credentials.store = current.base;
      current.owner = undefined;
      if (!preserveForReload) delete credentials[STATE_KEY];
    },
  };
}
