export const PERMISSION_AUDIT_UNAVAILABLE = 'PERMISSION_AUDIT_UNAVAILABLE';
export const RESOURCE_PERMISSIONS_UNAVAILABLE = 'RESOURCE_PERMISSIONS_UNAVAILABLE';

export const PRINCIPAL_PREPARATION_FAILED = 'PRINCIPAL_PREPARATION_FAILED';
export const DIRECTORY_VERIFICATION_UNAVAILABLE = 'DIRECTORY_VERIFICATION_UNAVAILABLE';

/** The lock store failed; a safe, retryable 503 instead of a raw driver error. */
export class ResourcePermissionsUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code: string = RESOURCE_PERMISSIONS_UNAVAILABLE;

  constructor() {
    super('Permissions for this resource cannot be updated right now, try again');
  }
}

export class ResourcePermissionsBusyError extends Error {
  readonly statusCode = 409;
  readonly code = 'RESOURCE_PERMISSIONS_BUSY';

  constructor() {
    super('Permissions for this resource are being updated, try again');
  }
}
