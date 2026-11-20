/** Object adapter shared by the transfer, cleanup and inventory operations. */
export const PROFILE_MEDIA_OBJECTS: symbol = Symbol('PROFILE_MEDIA_OBJECTS');

/** Transaction boundary for the exact profile media owner. */
export const PROFILE_MEDIA_UNIT_OF_WORK: symbol = Symbol('PROFILE_MEDIA_UNIT_OF_WORK');

/** Clock and UUIDv7 candidate allocation. */
export const PROFILE_MEDIA_RUNTIME: symbol = Symbol('PROFILE_MEDIA_RUNTIME');
