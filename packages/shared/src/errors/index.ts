export class SkyalyticWingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'SkyalyticWingError';
  }
}

export class GatewayError extends SkyalyticWingError {
  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message, 'GATEWAY_ERROR', statusCode, details);
    this.name = 'GatewayError';
  }
}

export class AgentError extends SkyalyticWingError {
  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message, 'AGENT_ERROR', statusCode, details);
    this.name = 'AgentError';
  }
}

export class ChannelError extends SkyalyticWingError {
  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message, 'CHANNEL_ERROR', statusCode, details);
    this.name = 'ChannelError';
  }
}

export class ProviderError extends SkyalyticWingError {
  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message, 'PROVIDER_ERROR', statusCode, details);
    this.name = 'ProviderError';
  }
}

export class ToolError extends SkyalyticWingError {
  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message, 'TOOL_ERROR', statusCode, details);
    this.name = 'ToolError';
  }
}

export class ConfigError extends SkyalyticWingError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFIG_ERROR', 400, details);
    this.name = 'ConfigError';
  }
}

export class AuthError extends SkyalyticWingError {
  constructor(message: string) {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'AuthError';
  }
}

export class PermissionError extends SkyalyticWingError {
  constructor(message: string) {
    super(message, 'PERMISSION_ERROR', 403);
    this.name = 'PermissionError';
  }
}

export class NotFoundError extends SkyalyticWingError {
  constructor(resource: string) {
    super(`${resource} not found`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends SkyalyticWingError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}
