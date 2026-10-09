export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); this.name = 'ApiError'; }
}
/** 401 on a normal route: the session is gone. */
export class AuthRequiredError extends ApiError { constructor(message = 'Login required') { super(401, message, 'auth_required'); this.name = 'AuthRequiredError'; } }
/** 429 from the login throttle. */
export class RateLimitedError extends ApiError { constructor(message: string, public retryAfter: number) { super(429, message, 'rate_limited'); this.name = 'RateLimitedError'; } }
/** fetch failed or timed out: the hub can't be reached. */
export class NetworkError extends Error { constructor(message = 'Network error') { super(message); this.name = 'NetworkError'; } }
