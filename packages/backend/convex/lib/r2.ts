import { AwsClient } from "aws4fetch";

export interface R2Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class StorageError extends Error {}

/** S3-compatible access to the private R2 bucket. Only the backend holds these credentials; runners and browsers get presigned URLs. */
export class R2Storage {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(cfg: R2Settings) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.base = `https://${cfg.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(cfg.bucket)}`;
  }

  objectUrl(key: string): string {
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const res = await this.client.fetch(`${this.objectUrl(key)}?uploads`, {
      method: "POST",
      headers: { "Content-Type": contentType },
    });
    const body = await res.text();
    if (!res.ok) throw new StorageError(`CreateMultipartUpload failed with ${res.status}`);
    const id = body.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
    if (!id) throw new StorageError("CreateMultipartUpload returned no UploadId");
    return id;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSeconds: number): Promise<string> {
    const url = new URL(this.objectUrl(key));
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", uploadId);
    url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
    const signed = await this.client.sign(new Request(url, { method: "PUT" }), { aws: { signQuery: true } });
    return signed.url;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const xml =
      "<CompleteMultipartUpload>" +
      sorted
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(normalizeEtag(p.etag))}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    const res = await this.client.fetch(`${this.objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml,
    });
    const body = await res.text();
    // S3 can return 200 with an <Error> body for CompleteMultipartUpload.
    if (!res.ok || body.includes("<Error>")) {
      const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? String(res.status);
      throw new StorageError(`CompleteMultipartUpload failed: ${code}`);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string) {
    const res = await this.client.fetch(`${this.objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new StorageError(`AbortMultipartUpload failed with ${res.status}`);
  }

  async headObject(key: string): Promise<{ sizeBytes: number } | null> {
    const res = await this.client.fetch(this.objectUrl(key), { method: "HEAD" });
    if (res.status === 404) return null;
    if (!res.ok) throw new StorageError(`HeadObject failed with ${res.status}`);
    return { sizeBytes: Number(res.headers.get("content-length") ?? "0") };
  }

  async putObject(key: string, body: string, contentType: string) {
    const res = await this.client.fetch(this.objectUrl(key), { method: "PUT", headers: { "Content-Type": contentType }, body });
    if (!res.ok) throw new StorageError(`PutObject failed with ${res.status}`);
  }

  async deleteObject(key: string) {
    const res = await this.client.fetch(this.objectUrl(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new StorageError(`DeleteObject failed with ${res.status}`);
  }

  async presignDownload(key: string, fileName: string, expiresSeconds: number): Promise<string> {
    const url = new URL(this.objectUrl(key));
    url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
    url.searchParams.set("response-content-disposition", `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    const signed = await this.client.sign(new Request(url, { method: "GET" }), { aws: { signQuery: true } });
    return signed.url;
  }
}

/**
 * Completes a multipart upload and returns the stored object's size (null if it is missing). An earlier request may
 * have completed the upload in R2 and then failed before the result was recorded; completing again then fails
 * (NoSuchUpload) although the object exists, so an existing object of the expected size is accepted instead.
 */
export async function completeOrRecoverUpload(
  storage: Pick<R2Storage, "completeMultipartUpload" | "headObject">,
  upload: { storageKey: string; r2UploadId: string; sizeBytes: number },
  parts: { partNumber: number; etag: string }[],
): Promise<{ sizeBytes: number } | null> {
  try {
    await storage.completeMultipartUpload(upload.storageKey, upload.r2UploadId, parts);
    return await storage.headObject(upload.storageKey);
  } catch (e) {
    if (!(e instanceof StorageError)) throw e;
    const head = await storage.headObject(upload.storageKey);
    if (!head || head.sizeBytes !== upload.sizeBytes) throw e;
    return head;
  }
}

function normalizeEtag(etag: string): string {
  const bare = etag.replace(/^"+|"+$/g, "");
  return `"${bare}"`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function storageKeyFor(buildId: string, attemptId: string, kind: string, fileName: string): string {
  return `builds/${buildId}/${attemptId}/${kind}/${fileName}`;
}
