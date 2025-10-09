export class DomainError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'ValidationError';
  }
}

export class ExternalServiceError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'ExternalServiceError';
  }
}
