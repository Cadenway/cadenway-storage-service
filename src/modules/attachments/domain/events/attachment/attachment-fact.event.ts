/** Minimal domain fact to be mapped to the published event and its actor by the use case. */
export interface AttachmentFact {
  // #region Properties
  /** Business fact committed by the lifecycle transition. */
  readonly type: 'file.uploaded.v1' | 'file.deleted.v1';

  /** Time of the accepted transition in UTC. */
  readonly occurredAt: string;

  /** Tenant that owns the file. */
  readonly organizationId: string;

  /** File identity used by consumers and the outbox version. */
  readonly fileId: string;

  /** Stable task owner reference. */
  readonly taskKey: string;

  /** Verified file size used by storage accounting. */
  readonly sizeBytes: number;

  /** Attachment revision after the change. */
  readonly version: number;
  // #endregion
}
