// Provider id -> plugin. The console reads describe() to build per-channel editors and validate drafts
// before they are saved; the worker resolves the plugin for each post target's channel.
import type { ChannelProvider } from './types.ts';
import { linkedinPersonal, linkedinPage } from './linkedin/index.ts';
import { facebookPage } from './facebook/index.ts';
import { instagram } from './instagram/index.ts';
import { x } from './x/index.ts';
import { youtube } from './youtube/index.ts';

export class ProviderRegistry {
  #providers = new Map<string, ChannelProvider>();

  register(p: ChannelProvider): this {
    if (this.#providers.has(p.id)) throw new Error(`provider ${p.id} is already registered`);
    this.#providers.set(p.id, p);
    return this;
  }

  get(id: string): ChannelProvider {
    const p = this.#providers.get(id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    return p;
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  list(): ChannelProvider[] {
    return [...this.#providers.values()];
  }

  describe() {
    return this.list().map(({ id, displayName, channelKind, capabilities, limits, auth, apiVersion }) => ({
      id, displayName, channelKind, capabilities, limits, apiVersion,
      auth: { type: auth.type, scopes: auth.scopes, refreshable: auth.refreshable, tokenLifetimeDays: auth.tokenLifetimeDays },
    }));
  }
}

export function defaultRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(linkedinPersonal).register(linkedinPage)
    .register(facebookPage).register(instagram).register(x).register(youtube);
}
