const FEE_PATTERN =
  /\b(bank\s*fee|service\s*fee|teenustasu|kuutasu|card\s*fee|transaction\s*fee|commission)\b/i;

export function looksLikeBankFee(description: string | null | undefined, amount: number): boolean {
  const abs = Math.abs(amount);
  if (abs > 50) {
    return false;
  }
  return FEE_PATTERN.test(description ?? "");
}
