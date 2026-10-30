import {
  repoTokenSchema,
  saveClaimResponseSchema,
  saveFilesResponseSchema,
  saveFinishResponseSchema,
  SAVE_PROTOCOL_VERSION,
  saveProgressResponseSchema,
  type RepoToken,
  type SaveClaimResponse,
  type SaveFile,
  type SaveFinishRequest,
  type SaveProgressRequest,
} from "@linxgen/spec";
import { requestJson, type FetchLike } from "./http";

export interface SaveApiClient {
  claim(saveAttemptId: string, dispatchNonce: string, oidcToken: string): Promise<SaveClaimResponse>;
  files(): Promise<{ files: SaveFile[] }>;
  token(): Promise<RepoToken>;
  progress(body: SaveProgressRequest): Promise<{ ok: boolean; cancelRequested: boolean }>;
  finish(body: SaveFinishRequest): Promise<{ saveStatus: string }>;
}

/** Client for the /runner/save routes. The capability from the claim authorizes every later call. */
export class SaveApi implements SaveApiClient {
  private capability: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private url(path: string) {
    return `${this.baseUrl}/runner/save/${path}`;
  }

  private get bearer(): string {
    if (!this.capability) throw new Error("save has not been claimed");
    return this.capability;
  }

  async claim(saveAttemptId: string, dispatchNonce: string, oidcToken: string) {
    const res = await requestJson(this.fetchImpl, this.url("claim"), {
      token: oidcToken,
      body: { protocolVersion: SAVE_PROTOCOL_VERSION, saveAttemptId, dispatchNonce },
      schema: saveClaimResponseSchema,
      timeoutMs: 60_000,
    });
    this.capability = res.capability;
    return res;
  }

  files() {
    return requestJson(this.fetchImpl, this.url("files"), { token: this.bearer, body: {}, schema: saveFilesResponseSchema });
  }

  token() {
    return requestJson(this.fetchImpl, this.url("token"), { token: this.bearer, body: {}, schema: repoTokenSchema });
  }

  progress(body: SaveProgressRequest) {
    return requestJson(this.fetchImpl, this.url("progress"), { token: this.bearer, body, schema: saveProgressResponseSchema, retries: 2 });
  }

  finish(body: SaveFinishRequest) {
    return requestJson(this.fetchImpl, this.url("finish"), { token: this.bearer, body, schema: saveFinishResponseSchema, retries: 6 });
  }
}
