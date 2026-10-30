import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function refundSplitPaymentPart(partId: string) {
  const admin = createAdminClient();

  const { data: part, error: partError } = await admin
    .from("service_payment_parts")
    .select("id, service_payment_id, amount_cents, currency, payment_status, stripe_payment_intent_id, stripe_charge_id")
    .eq("id", partId)
    .single();

  if (partError || !part) {
    throw new Error("Split-payment part not found");
  }

  if (part.payment_status === "refunded") {
    return true;
  }

  if (
    part.payment_status !== "succeeded" ||
    !part.stripe_payment_intent_id ||
    !part.stripe_charge_id ||
    part.currency !== "usd"
  ) {
    throw new Error("Split-payment part is not eligible for refund");
  }

  const { data: reserved, error: reserveError } = await admin.rpc(
    "claim_split_payment_refund",
    { part_id_input: part.id }
  );

  if (reserveError || !reserved) {
    throw new Error("Unable to reserve split-payment refund");
  }

  const intent = await stripe.paymentIntents.retrieve(
    part.stripe_payment_intent_id
  );

  if (
    intent.status !== "succeeded" ||
    intent.amount_received !== Number(part.amount_cents) ||
    intent.currency !== "usd" ||
    intent.metadata.service_payment_part_id !== part.id ||
    intent.metadata.service_payment_id !== part.service_payment_id ||
    (typeof intent.latest_charge === "string"
      ? intent.latest_charge
      : intent.latest_charge?.id) !== part.stripe_charge_id
  ) {
    throw new Error("Stripe refund verification failed");
  }

  // Reconcile existing Stripe refunds before creating another.
  const existingRefunds = await stripe.refunds.list({
    payment_intent: intent.id,
    limit: 100,
  });

  if (existingRefunds.has_more) {
    throw new Error("Refund history requires manual reconciliation");
  }

  const matchingRefunds = existingRefunds.data.filter(
    (refund) =>
      refund.payment_intent === intent.id &&
      refund.amount === Number(part.amount_cents) &&
      refund.currency === part.currency &&
      refund.metadata?.service_payment_part_id === part.id
  );

  if (
    matchingRefunds.length > 1 ||
    existingRefunds.data.length !== matchingRefunds.length
  ) {
    throw new Error(
      "Unexpected or multiple Stripe refunds require manual review"
    );
  }

  const existingRefund = matchingRefunds[0];

  if (existingRefund?.status === "pending") {
    throw new Error(
      `Stripe refund ${existingRefund.id} is pending; retry reconciliation later`
    );
  }

  if (existingRefund && existingRefund.status !== "succeeded") {
    throw new Error(
      `Stripe refund ${existingRefund.id} is ${existingRefund.status}; manual review required`
    );
  }

  const refund = existingRefund ?? await stripe.refunds.create(
    {
      payment_intent: intent.id,
      amount: Number(part.amount_cents),
      reason: "requested_by_customer",
      metadata: {
        service_payment_id: part.service_payment_id,
        service_payment_part_id: part.id,
      },
    },
    {
      idempotencyKey: `split-payment-refund-${part.id}-v1`,
    }
  );

  if (refund.status !== "succeeded") {
    throw new Error(
      `Refund ${refund.id} is ${refund.status}; reconciliation required`
    );
  }

  const { error: recordError } = await admin.rpc(
    "record_split_payment_refund",
    {
      part_id_input: part.id,
      payment_intent_id_input: intent.id,
    }
  );

  if (recordError) {
    throw new Error(
      `Stripe refund ${refund.id} succeeded but database update failed`
    );
  }

  return true;
}
