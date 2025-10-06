export class ServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ServiceError";
  }
}

export class ExternalServiceError extends ServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ExternalServiceError";
  }
}
