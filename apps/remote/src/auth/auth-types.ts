import type { PasswordPrincipal } from "@kindergarten/contracts";

export type AuthPrincipal = PasswordPrincipal;

export interface AuthUserView extends AuthPrincipal {
  disabled: boolean;
  createdAt: string;
}

export interface CreatedLoginSession {
  token: string;
  expiresAt: string;
}
