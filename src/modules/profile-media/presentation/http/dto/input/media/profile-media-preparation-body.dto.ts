import { PrepareProfileMediaInternalBody } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates the kind of the reserved media to prepare. */
export class ProfileMediaPreparationBody extends zodDto(PrepareProfileMediaInternalBody) {}
