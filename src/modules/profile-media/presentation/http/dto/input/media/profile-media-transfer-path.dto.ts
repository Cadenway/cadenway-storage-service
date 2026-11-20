import { SignProfileMediaTransferInternalParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates the upload identity for a reserved transfer. */
export class ProfileMediaTransferPath extends zodDto(SignProfileMediaTransferInternalParams) {}
