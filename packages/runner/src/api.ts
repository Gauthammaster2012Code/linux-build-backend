import {
  claimResponseSchema,
  eventsResponseSchema,
  finishResponseSchema,
  RUNNER_PROTOCOL_VERSION,
  uploadCompleteResponseSchema,
  uploadPartsResponseSchema,
  uploadStartResponseSchema,
  type ClaimResponse,
  type EventsRequest,
  type FinishRequest,
  type UploadStartRequest,
} from "@linxgen/spec";
import { requestJson, type FetchLike } from "./http";

export interface RunnerApiClient {
  events(body: EventsRequest): Promise<{ ok: boolean; cancelRequested: boolean; duplicate?: boolean }>;
  uploadStart(body: UploadStartRequest): Promise<{ uploadId: string; partSizeBytes: number; partCount: number }>;
  uploadParts(uploadId: string, partNumbers: number[]): Promise<{ urls: { partNumber: number; url: string }[]; expiresAt: number }>;
  uploadComplete(uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<{ artifactId: string }>;
  finish(body: FinishRequest): Promise<{ buildStatus: string }>;
}

export class RunnerApi implements RunnerApiClient {
  private capability: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private url(path: string) {
    return `${this.baseUrl}/runner/${path}`;
  }

  private get token(): string {
    if (!this.capability) throw new Error("attempt has not been claimed");
    return this.capability;
  }

  async claim(attemptId: string, dispatchNonce: string, oidcToken: string): Promise<ClaimResponse> {
    // Claims are not retried on 4xx; a duplicate claim from the same run is accepted idempotently by the backend.
    const res = await requestJson(this.fetchImpl, this.url("claim"), {
      token: oidcToken,
      body: { protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, dispatchNonce },
      schema: claimResponseSchema,
    });
    this.capability = res.capability;
    return res;
  }

  events(body: EventsRequest) {
    return requestJson(this.fetchImpl, this.url("events"), { token: this.token, body, schema: eventsResponseSchema, retries: 2 });
  }

  uploadStart(body: UploadStartRequest) {
    return requestJson(this.fetchImpl, this.url("uploads/start"), { token: this.token, body, schema: uploadStartResponseSchema });
  }

  uploadParts(uploadId: string, partNumbers: number[]) {
    return requestJson(this.fetchImpl, this.url("uploads/parts"), {
      token: this.token,
      body: { uploadId, partNumbers },
      schema: uploadPartsResponseSchema,
    });
  }

  uploadComplete(uploadId: string, parts: { partNumber: number; etag: string }[]) {
    return requestJson(this.fetchImpl, this.url("uploads/complete"), {
      token: this.token,
      body: { uploadId, parts },
      schema: uploadCompleteResponseSchema,
      timeoutMs: 120_000,
    });
  }

  finish(body: FinishRequest) {
    return requestJson(this.fetchImpl, this.url("finish"), { token: this.token, body, schema: finishResponseSchema, retries: 6 });
  }
}
