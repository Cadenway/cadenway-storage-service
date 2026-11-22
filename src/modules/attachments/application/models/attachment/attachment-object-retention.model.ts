/** Authority to erase an object's historical versions after its cleanup fence commits. */
export type AttachmentObjectRetention = 'preserve' | 'candidate' | 'transient';
