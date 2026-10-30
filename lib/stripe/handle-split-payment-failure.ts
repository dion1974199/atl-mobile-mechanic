import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";

export async function handleSplitPaymentFailure(
  paymentIntent: Stripe.PaymentIntent
): Promise<boolean> {
  const partId = paymentIntent.metadata?.service_payment_part_id;

  if (!partId) {
    return false;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const currentIntent = await stripe.paymentIntents.retrieve(paymentIntent.id);

  // Ignore delayed failure events if the PaymentIntent has moved forward.
  if (
    currentIntent.status !== "canceled" &&
    currentIntent.status !== "requires_payment_method"
  ) {
    return true;
  }

  paymentIntent = currentIntent;

  const failureStatus =
    paymentIntent.status === "canceled"
      ? "canceled"
      : paymentIntent.status === "requires_payment_method"
        ? "failed"
        : null;

  if (!failureStatus) {
    throw new Error("Unexpected Stripe status for split-payment failure");
  }

  const admin = createAdminClient();

  const { data: part, error: partError } = await admin
    .from("service_payment_parts")
    .select(
      "id, service_payment_id, stripe_payment_intent_id, amount_cents, currency"
    )
    .eq("id", partId)
    .single();

  if (partError || !part) {
    throw new Error("Split-payment part not found");
  }

  if (
    part.stripe_payment_intent_id !== paymentIntent.id ||
    part.currency !== paymentIntent.currency ||
    Number(part.amount_cents) !== paymentIntent.amount ||
    paymentIntent.metadata.service_payment_id !== part.service_payment_id
  ) {
    throw new Error("Split-payment failure verification failed");
  }

  const { error } = await admin.rpc("record_split_payment_failure", {
    part_id_input: part.id,
    payment_intent_id_input: paymentIntent.id,
    failure_status_input: failureStatus,
  });

  if (error) {
    throw new Error(`Unable to record split-payment failure: ${error.message}`);
  }

  return true;
}
