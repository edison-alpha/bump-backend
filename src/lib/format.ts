export { round2 } from "@bump/shared";

/** "+$1.23" / "-$0.50", for push notification text. */
export const signedUsdText = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
