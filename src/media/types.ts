// Media generation providers (AI video and friends). A media job turns inputs into an asset:
//   submit -> poll (or webhook) -> fetch the output -> store it as a media asset -> optionally attach to a draft.
// The output is never published by itself: it reaches a channel only inside a post that passes the approval gate.
// v1 implements one capability (avatar_video) with one provider (HeyGen). The shape leaves room for more
// (voice clone with consent, dubbing, image/video generation) without changing the worker.
import type { HttpClient } from '../providers/http.ts';

export type MediaCapability = 'avatar_video';

export interface AvatarVideoParams {
  /** What the avatar says. */
  script: string;
  /** Provider's avatar id (HeyGen: a look id from GET /v3/avatars/looks). */
  avatarId: string;
  /** Provider's voice id; omitted = the avatar's default voice. */
  voiceId?: string;
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:5' | '5:4';
  resolution?: '720p' | '1080p';
  title?: string;
}

export interface MediaJobRequest { capability: MediaCapability; params: AvatarVideoParams; idempotencyKey: string }

export type MediaJobStatus =
  | { state: 'running'; progress?: number }
  | { state: 'done'; output: { fetchUrl: string; mime: string }; usage?: Record<string, number | string> }
  | { state: 'failed'; error: string };

export interface MediaContext {
  /** Resolved in memory from the environment variable the job names; never logged or stored. */
  apiKey: string;
  http: HttpClient;
  now(): Date;
}

export interface MediaProvider {
  readonly id: string;
  readonly capabilities: MediaCapability[];
  /** Default environment variable NAME for the API key. */
  readonly keyEnv: string;
  readonly docs: string[];
  validate(req: MediaJobRequest): string[];
  /** Creates the job at the provider (costs money). Throws ProviderError; 'unknown_outcome' is never retried blind. */
  submit(ctx: MediaContext, req: MediaJobRequest): Promise<{ externalJobId: string }>;
  poll(ctx: MediaContext, externalJobId: string): Promise<MediaJobStatus>;
}
