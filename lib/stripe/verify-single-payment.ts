import Stripe from "stripe";

export async function verifySinglePayment(
  stripe: Stripe,
  paymentIntentId: string,
  paymentId: string,
  requestId: string,
  expectedAmountCents: number,
  expectedTransferGroup: string
): Promise<string> {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

  const chargeId =
    typeof intent.latest_charge === "string"
      ? intent.latest_charge
      : intent.latest_charge?.id;

  if (
    intent.status !== "succeeded" ||
    intent.amount_received !== expectedAmountCents ||
    intent.currency !== "usd" ||
    intent.metadata.service_payment_id !== paymentId ||
    intent.metadata.service_request_id !== requestId ||
    intent.transfer_group !== expectedTransferGroup ||
    !chargeId
  ) {
    throw new Error("Single-card PaymentIntent verification failed");
  }

  const charge = await stripe.charges.retrieve(chargeId);

  if (
    charge.payment_intent !== intent.id ||
    charge.amount !== expectedAmountCents ||
    charge.currency !== "usd" ||
    charge.status !== "succeeded" ||
    charge.paid !== true ||
    charge.refunded ||
    charge.amount_refunded !== 0 ||
    charge.disputed
  ) {
    throw new Error("Single-card charge is refunded, disputed, or invalid");
  }

  const refunds = await stripe.refunds.list({
    payment_intent: intent.id,
    limit: 1,
  });

  if (refunds.data.length > 0 || refunds.has_more) {
    throw new Error("Single-card payment has refund activity");
  }

  return chargeId;
}
