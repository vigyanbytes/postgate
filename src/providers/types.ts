// The provider plugin contract. One module per channel; providers are stateless and read no env:
// everything they need (token, channel, http, media, clock) arrives in ProviderContext.
import type { HttpClient } from './http.ts';
import type { Tracer } from '../telemetry/tracer.ts';

export type ChannelKind = 'personal' | 'page' | 'group' | 'bot' | 'blog' | 'newsletter';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  refreshExpiresAt?: Date;
  scopes?: string[];
}

export interface Capabilities {
  post: {
    text: boolean; image: boolean; maxImages: number; video: boolean; document: boolean;
    carousel: boolean; thread: boolean; firstComment: boolean; textOnlyAllowed: boolean;
  };
  delete: boolean;
  /** Can look up a post after a create call with an unknown outcome. */
  reconcile: boolean;
}

export interface Limits {
  maxChars: number;
  maxCommentChars?: number;
  maxImageBytes?: number;
  maxVideoBytes?: number;
  maxDocumentBytes?: number;
  imageMimes?: string[];
  videoMimes?: string[];
  documentMimes?: string[];
}

export interface AuthSpec {
  type: 'oauth2' | 'app_password' | 'bot_token' | 'api_key';
  scopes: string[];
  refreshable: boolean;
  tokenLifetimeDays?: number;
  /** Environment variable NAMES that hold the platform app credentials, never values. */
  secretNames: { clientId?: string; clientSecret?: string };
}

export interface MediaItem {
  id: string;
  kind: 'image' | 'video' | 'document';
  mime: string;
  sizeBytes: number;
  altText?: string;
  title?: string;
}

export interface PublishRequest {
  /** Stable per post target; providers that accept an idempotency key send it. */
  idempotencyKey: string;
  text: string;
  title?: string;
  linkUrl?: string;
  media: MediaItem[];
  settings: Record<string, unknown>;
}

export interface PublishResult {
  externalId: string;
  url?: string;
  /** Non-fatal facts the worker records with the publish event, e.g. a thread that stopped part-way. */
  notes?: Record<string, unknown>;
}

export interface Issue {
  field: string;
  code: string;
  message: string;
}

export interface ChannelRef {
  id: string;
  kind: ChannelKind;
  /** The platform's id for the account we act as, e.g. urn:li:person:abc. */
  externalId: string;
  settings: Record<string, unknown>;
}

export interface MediaReader {
  read(id: string): Promise<Uint8Array>;
  /** A short-lived public URL for the asset. Meta (Instagram, Facebook video) pulls media from a URL. */
  publicUrl?(id: string): Promise<string>;
}

export interface ProviderContext {
  channel: ChannelRef;
  token: TokenSet;
  http: HttpClient;
  media: MediaReader;
  tracer: Tracer;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface AuthorizeInput {
  clientId: string;
  redirectUri: string;
  state: string;
  /** PKCE (S256) challenge, for providers that require it (X). */
  codeChallenge?: string;
}

export interface ExchangeInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  /** PKCE verifier matching AuthorizeInput.codeChallenge. */
  codeVerifier?: string;
  http: HttpClient;
  now(): Date;
}

export interface ConnectableAccount {
  externalId: string;
  displayName: string;
  kind: ChannelKind;
  /** Account-specific token when it differs from the user token (Facebook Page tokens). */
  token?: TokenSet;
}

export interface ConnectResult {
  token: TokenSet;
  accounts: ConnectableAccount[];
}

export interface RefreshInput {
  clientId: string;
  clientSecret: string;
  token: TokenSet;
  http: HttpClient;
  now(): Date;
}

export interface ChannelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly channelKind: ChannelKind;
  readonly capabilities: Capabilities;
  readonly limits: Limits;
  readonly auth: AuthSpec;
  readonly apiVersion?: { value: string; sunsetsOn: string };

  authorizeUrl(input: AuthorizeInput): string;
  exchangeCode(input: ExchangeInput): Promise<ConnectResult>;
  /** Throws ProviderError('reconnect') when the token cannot be refreshed. */
  refresh(input: RefreshInput): Promise<TokenSet>;
  validate(req: PublishRequest): Issue[];
  publish(ctx: ProviderContext, req: PublishRequest): Promise<PublishResult>;
  reconcile?(ctx: ProviderContext, req: PublishRequest): Promise<PublishResult | null>;
  delete(ctx: ProviderContext, externalId: string): Promise<void>;
  comment?(ctx: ProviderContext, externalId: string, text: string): Promise<{ externalId: string }>;
}
