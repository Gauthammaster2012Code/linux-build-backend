import { AwsClient } from "aws4fetch";

export interface ObjectStorageSettings {
  /** https origin of the S3-compatible API, for example https://s3.us-west-004.backblazeb2.com. */
  endpoint: string;
  /** SigV4 signing region, for example us-west-004. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class StorageError extends Error {}

type FetchLike = typeof fetch;

/**
 * S3-compatible access to the private temporary-storage bucket (Backblaze B2). Only the backend holds these
 * credentials; runners and browsers get presigned URLs. Requests use path-style URLs
 * (`<endpoint>/<bucket>/<key>`), which B2 documents for every operation.
 */
export class ObjectStorage {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(cfg: ObjectStorageSettings, fetchImpl?: FetchLike) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: cfg.region,
    });
    this.base = `${cfg.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(cfg.bucket)}`;
    this.fetchImpl = fetchImpl;
  }

  private readonly fetchImpl: FetchLike | undefined;

  private async send(url: string, init: RequestInit): Promise<Response> {
    const signed = await this.client.sign(url, init);
    return (this.fetchImpl ?? fetch)(signed);
  }

  objectUrl(key: string): string {
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async createMultipartUpload(key: string, contentType: string, downloadName?: string): Promise<string> {
    const res = await this.send(`${this.objectUrl(key)}?uploads`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        ...(downloadName ? { "Content-Disposition": contentDisposition(downloadName) } : {}),
      },
    });
    const body = await res.text();
    if (!res.ok) throw new StorageError(`CreateMultipartUpload failed with ${res.status}`);
    const id = body.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
    if (!id) throw new StorageError("CreateMultipartUpload returned no UploadId");
    return unescapeXml(id);
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
      '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      sorted
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(normalizeEtag(p.etag))}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    const res = await this.send(`${this.objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, {
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
    const res = await this.send(`${this.objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new StorageError(`AbortMultipartUpload failed with ${res.status}`);
  }

  async headObject(key: string): Promise<{ sizeBytes: number } | null> {
    const res = await this.send(this.objectUrl(key), { method: "HEAD" });
    if (res.status === 404) return null;
    if (!res.ok) throw new StorageError(`HeadObject failed with ${res.status}`);
    return { sizeBytes: Number(res.headers.get("content-length") ?? "0") };
  }

  async putObject(key: string, body: string, contentType: string) {
    const res = await this.send(this.objectUrl(key), { method: "PUT", headers: { "Content-Type": contentType }, body });
    if (!res.ok) throw new StorageError(`PutObject failed with ${res.status}`);
  }

  /** Version ids stored under exactly this key, including delete markers. */
  async listVersions(key: string): Promise<string[]> {
    const url = new URL(this.base);
    url.searchParams.set("versions", "");
    url.searchParams.set("prefix", key);
    url.searchParams.set("max-keys", "1000");
    const res = await this.send(url.toString(), { method: "GET" });
    const body = await res.text();
    if (!res.ok) throw new StorageError(`ListObjectVersions failed with ${res.status}`);
    const ids: string[] = [];
    for (const m of body.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
      const entry = m[2] ?? "";
      const entryKey = entry.match(/<Key>([^<]*)<\/Key>/)?.[1];
      const versionId = entry.match(/<VersionId>([^<]*)<\/VersionId>/)?.[1];
      if (entryKey !== undefined && versionId && unescapeXml(entryKey) === key) ids.push(unescapeXml(versionId));
    }
    return ids;
  }

  /**
   * Permanently removes an object. B2 buckets keep file versions: a DELETE without a version id only adds a delete
   * marker (hides the file) and the bytes stay stored and billed, so every version under the key is deleted by id.
   */
  async deleteObject(key: string) {
    for (const versionId of await this.listVersions(key)) {
      const res = await this.send(`${this.objectUrl(key)}?versionId=${encodeURIComponent(versionId)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new StorageError(`DeleteObject failed with ${res.status}`);
    }
  }

  async presignDownload(key: string, fileName: string, expiresSeconds: number): Promise<string> {
    const url = new URL(this.objectUrl(key));
    url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
    url.searchParams.set("response-content-disposition", contentDisposition(fileName));
    const signed = await this.client.sign(new Request(url, { method: "GET" }), { aws: { signQuery: true } });
    return signed.url;
  }
}

/**
 * Completes a multipart upload and returns the stored object's size (null if it is missing). An earlier request may
 * have completed the upload in storage and then failed before the result was recorded; completing again then fails
 * (NoSuchUpload) although the object exists, so an existing object of the expected size is accepted instead.
 */
export async function completeOrRecoverUpload(
  storage: Pick<ObjectStorage, "completeMultipartUpload" | "headObject">,
  upload: { storageKey: string; storageUploadId: string; sizeBytes: number },
  parts: { partNumber: number; etag: string }[],
): Promise<{ sizeBytes: number } | null> {
  try {
    await storage.completeMultipartUpload(upload.storageKey, upload.storageUploadId, parts);
    return await storage.headObject(upload.storageKey);
  } catch (e) {
    if (!(e instanceof StorageError)) throw e;
    const head = await storage.headObject(upload.storageKey);
    if (!head || head.sizeBytes !== upload.sizeBytes) throw e;
    return head;
  }
}

function contentDisposition(fileName: string): string {
  return `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
}

function normalizeEtag(etag: string): string {
  const bare = etag.replace(/^"+|"+$/g, "");
  return `"${bare}"`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function storageKeyFor(buildId: string, attemptId: string, kind: string, fileName: string): string {
  return `builds/${buildId}/${attemptId}/${kind}/${fileName}`;
}
