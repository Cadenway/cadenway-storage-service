import { DeleteObjectsCommand, ListObjectVersionsCommand, type S3Client } from '@aws-sdk/client-s3';

const versionPageSize = 100;
const erasureBatchLimit = 10;

/** Uses the private restore-evidence namespace shared by attachment and profile media. */
export function restoreProofKey(key: string): string {
  return 'attachment-restore-pins/' + key;
}

async function listBoundedVersions(
  storage: S3Client,
  bucket: string,
  key: string,
  limit: number,
  signal: AbortSignal,
) {
  const page = await storage.send(
    new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: limit }),
    { abortSignal: signal },
  );
  const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
  if (
    typeof page.IsTruncated !== 'boolean' ||
    versions.length > limit ||
    (page.IsTruncated && versions.length === 0) ||
    versions.some(({ Key }) => !Key?.startsWith(key))
  ) {
    throw new Error('Invalid object version listing.');
  }
  return versions;
}

/** Looks for an exact key even when S3's current generation is a delete marker. */
export async function hasS3ObjectHistory(
  storage: S3Client,
  bucket: string,
  key: string,
  signal: AbortSignal,
): Promise<boolean> {
  const versions = await listBoundedVersions(storage, bucket, key, 1, signal);
  return versions.some(({ Key }) => Key === key);
}

/** Erases only listed versions of a fenced key, in a bounded and retryable operation. */
export async function eraseS3ObjectVersions(
  storage: S3Client,
  bucket: string,
  key: string,
  signal: AbortSignal,
): Promise<void> {
  const options = { abortSignal: signal };
  for (let batch = 0; batch <= erasureBatchLimit; batch++) {
    // Start from the first page after each deletion to avoid skipping partially deleted versions.
    const page = await listBoundedVersions(storage, bucket, key, versionPageSize, signal);
    const versions = page
      .filter(({ Key }) => Key === key)
      .map(({ VersionId }) => {
        if (!VersionId) throw new Error('Object version has no identifier.');
        return { Key: key, VersionId };
      });
    if (versions.length === 0) return;
    if (batch === erasureBatchLimit) break;
    const result = await storage.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: versions, Quiet: true } }),
      options,
    );
    if (result.Errors?.length) break;
  }
  throw new Error('Object version erasure is incomplete.');
}
