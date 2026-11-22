import type { ProfileMediaObjectRetention } from './profile-media-object-retention.model.js';

/** Retention of a newly registered derivative before it can be elected. */
export type ProfileMediaCandidateRetention = Exclude<ProfileMediaObjectRetention, 'transient'>;
