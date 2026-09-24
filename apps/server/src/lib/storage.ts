import { createHash } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { config } from "../config.js";

/** Object storage S3-compatible (MinIO). */
export const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
});

const Bucket = config.S3_BUCKET;

export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }));
  }
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function putObject(key: string, body: Buffer | string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getObjectStream(key: string): Promise<{ body: Readable; size?: number; contentType?: string }> {
  const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  return {
    body: res.Body as Readable,
    size: res.ContentLength,
    contentType: res.ContentType,
  };
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function checkStorage(): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Unggah stream ke object storage sambil menghitung sha256 & ukuran.
 * Tidak menampung seluruh berkas di memori (aman untuk video besar).
 */
export async function putStream(
  key: string,
  stream: Readable,
  contentType: string,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  const pass = new PassThrough();
  stream.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    size += chunk.length;
  });
  stream.on("error", (err) => pass.destroy(err));
  stream.pipe(pass);
  const upload = new Upload({
    client: s3,
    params: { Bucket, Key: key, Body: pass, ContentType: contentType },
  });
  await upload.done();
  return { size, sha256: hash.digest("hex") };
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}
