/** Verified ready attachment usage or a retained terminal deletion. */
export type BillingAttachmentUsageProjection =
  | {
      readonly fileId: string;
      readonly version: number;
      readonly state: 'ready';
      readonly sizeBytes: number;
    }
  | { readonly fileId: string; readonly version: number; readonly state: 'deleted' };
