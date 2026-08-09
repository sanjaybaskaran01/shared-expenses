export interface AuthEmailPlacementInput {
  invitationToken: string | null | undefined;
  migrationClaimToken: string | null | undefined;
}

export function authEmailPlacement(input: AuthEmailPlacementInput): {
  shared: boolean;
  magicLinkForm: boolean;
} {
  const shared = Boolean(input.invitationToken || input.migrationClaimToken);
  return { shared, magicLinkForm: !shared };
}
