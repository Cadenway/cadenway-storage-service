import { PrepareProfileMediaInternalParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates the upload identity for preparation. */
export class ProfileMediaPreparationPath extends zodDto(PrepareProfileMediaInternalParams) {}
