import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Cloudflare R2 client — menu item image uploads (Section 12, Phase 2 item 4).
// R2 is S3-compatible; this is a thin wrapper around the AWS S3 SDK pointed at
// the venue-agnostic R2 endpoint. Bucket layout is per-venue-prefixed
// (venues/<venueId>/items/<sku>/<uuid>.<ext>) so one venue can never read or
// overwrite another's objects even though the bucket itself is shared.
// ---------------------------------------------------------------------------

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB cap (spec: enforce on presign + confirm)
const PRESIGN_TTL_SECONDS = 5 * 60; // 5 minutes

// Fixed map — extension is NEVER derived from the client's original filename.
export const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;
  const { r2AccountId, r2AccessKeyId, r2SecretAccessKey, r2Bucket } = config;
  if (!r2AccountId || !r2AccessKeyId || !r2SecretAccessKey || !r2Bucket) {
    throw new Error('r2_not_configured');
  }
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
    forcePathStyle: true,
  });
  return client;
}

// Presigned PUT, constrained to an exact content-length. Binding ContentLength
// into the signature means R2 rejects a PUT whose actual body size differs
// from what was declared here — this IS enforced by the signature (verified).
//
// Content-Type is NOT signature-bound, and cannot be made so: the AWS SDK's S3
// presigner unconditionally treats content-type as an "unsignable" header
// (@aws-sdk/s3-request-presigner's prepareRequest() hardcodes
// `unsignableHeaders.add("content-type")`, independent of any options passed
// to getSignedUrl) — this is an S3/R2 presigned-URL limitation, not something
// this code can override. Verified by testing: a PUT with a different
// Content-Type than presigned for still satisfies the signature.
// Consequently the actual stored Content-Type must be re-validated at CONFIRM
// time, after the upload, by inspecting the real object (see headObject below
// and the check in admin.ts) — that is the real enforcement point.
export async function presignPutObject(key: string, contentType: string, contentLength: number): Promise<string> {
  const s3 = getClient();
  const cmd = new PutObjectCommand({
    Bucket: config.r2Bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  return getSignedUrl(s3, cmd, { expiresIn: PRESIGN_TTL_SECONDS });
}

export async function headObject(key: string): Promise<{ contentLength: number; contentType: string | null } | null> {
  const s3 = getClient();
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: config.r2Bucket, Key: key }));
    return { contentLength: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export async function deleteObject(key: string): Promise<void> {
  const s3 = getClient();
  await s3.send(new DeleteObjectCommand({ Bucket: config.r2Bucket, Key: key }));
}

export function publicUrlForKey(key: string): string {
  const base = config.r2PublicBaseUrl.replace(/\/$/, '');
  return `${base}/${key}`;
}

// Inverse of publicUrlForKey — used to find the previous object's key from the
// image_url already stored on the menu item, so it can be cleaned up on replace.
export function keyFromPublicUrl(url: string): string | null {
  const base = config.r2PublicBaseUrl.replace(/\/$/, '');
  if (!base || !url.startsWith(`${base}/`)) return null;
  return url.slice(base.length + 1);
}
