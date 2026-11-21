import type { AttachmentActor } from '../../../../models/attachment/attachment-actor.model.js';

/** A verified task purge event's tenant and stable task identity. */
export interface RecordTaskPurgeInput {
  // #region Properties
  /** Tenant and task from the event envelope. */
  readonly organizationId: string;
  readonly taskKey: string;

  /** Original actor from the task purge event, reused by deletion facts. */
  readonly actor: AttachmentActor;
  // #endregion
}
