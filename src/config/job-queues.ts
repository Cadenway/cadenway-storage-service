import type { JobQueueDeclaration } from '@cadenway/nest-jobs/provisioning';

/** System-only queue for expiring encrypted upload receipts. */
export const PURGE_UPLOAD_RECEIPTS_QUEUE: string = 'storage.purge-upload-receipts';

/** System-only queue for matching physical late writes to finished cleanup records. */
export const RECONCILE_ATTACHMENT_OBJECTS_QUEUE: string = 'storage.reconcile-attachment-objects';

/** System-only queue for discovering pending task and object cleanup. */
export const SWEEP_ATTACHMENT_CLEANUP_QUEUE: string = 'storage.sweep-attachment-cleanup';

/** System-only queue for reclaiming retired or abandoned private profile images. */
export const SWEEP_PROFILE_MEDIA_QUEUE: string = 'storage.sweep-profile-media';

/** System-only queue for inventory of known profile media objects after an erasure. */
export const RECONCILE_PROFILE_MEDIA_QUEUE: string = 'storage.reconcile-profile-media';

/** Queue declarations shared by the migrator and the application worker. */
export const jobQueues: readonly JobQueueDeclaration[] = [
  {
    name: PURGE_UPLOAD_RECEIPTS_QUEUE,
    retryLimit: 8,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 1_800,
    expireInSeconds: 900,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 604_800,
    deadLetterRetentionSeconds: 1_209_600,
  },
  {
    name: RECONCILE_ATTACHMENT_OBJECTS_QUEUE,
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 300,
    expireInSeconds: 60,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 604_800,
    deadLetterRetentionSeconds: 1_209_600,
  },
  {
    name: SWEEP_ATTACHMENT_CLEANUP_QUEUE,
    retryLimit: 8,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 1_800,
    expireInSeconds: 900,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 604_800,
    deadLetterRetentionSeconds: 1_209_600,
  },
  {
    name: SWEEP_PROFILE_MEDIA_QUEUE,
    retryLimit: 8,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 1_800,
    expireInSeconds: 900,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 604_800,
    deadLetterRetentionSeconds: 1_209_600,
  },
  {
    name: RECONCILE_PROFILE_MEDIA_QUEUE,
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 300,
    expireInSeconds: 60,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 604_800,
    deadLetterRetentionSeconds: 1_209_600,
  },
];
