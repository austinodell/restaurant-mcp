/** True when the verified Access email is the single configured owner. */
export function identityAllowed(email: string | undefined, ownerEmail: string | undefined): boolean {
  const presented = email?.trim().toLowerCase();
  const owner = ownerEmail?.trim().toLowerCase();
  if (!presented || !owner) return false;
  return presented === owner;
}
