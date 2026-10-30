import Stripe from "stripe";

export async function findSplitPaymentIntent(
  stripe: Stripe,
  partId: string
): Promise<Stripe.PaymentIntent | null> {
  const safePartId = partId.replace(/[^a-fA-F0-9-]/g, "");

  if (safePartId !== partId) {
    throw new Error("Invalid split-payment card ID");
  }

  const result = await stripe.paymentIntents.search({
    query: `metadata['service_payment_part_id']:'${safePartId}'`,
    limit: 2,
  });

  if (result.has_more || result.data.length > 1) {
    throw new Error(
      "Multiple Stripe PaymentIntents require manual reconciliation"
    );
  }

  return result.data[0] ?? null;
}
