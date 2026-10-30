import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySinglePayment } from "./verify-single-payment";

// Read-only Stripe checks for every charge funding a transfer, including both cards.
export async function verifyTransferFunding(stripe: Stripe, paymentId: string) {
  const admin = createAdminClient();
  const { data: payment, error } = await admin.from("service_payments")
    .select("request_id, authorized_amount, stripe_payment_intent_id, payout_hold_reason")
    .eq("id", paymentId).single();
  if (error || !payment || payment.payout_hold_reason != null) {
    throw new Error("Payment funding is held or unavailable");
  }
  const { data: parts, error: partsError } = await admin.from("service_payment_parts")
    .select("stripe_payment_intent_id, amount_cents, stripe_charge_id, id")
    .eq("service_payment_id", paymentId);
  if (partsError) throw partsError;
  const group = `service_request_${payment.request_id}`;
  if (payment.stripe_payment_intent_id) {
    if (parts?.length) throw new Error("Mixed payment modes");
    await verifySinglePayment(stripe, payment.stripe_payment_intent_id, paymentId,
      payment.request_id, Math.round(Number(payment.authorized_amount) * 100), group);
    return;
  }
  if (parts?.length !== 2) throw new Error("Two funding parts required");
  for (const part of parts) {
    if (!part.stripe_payment_intent_id || !part.stripe_charge_id) {
      throw new Error("Split funding identifiers missing");
    }
    const chargeId = await verifySinglePayment(stripe, part.stripe_payment_intent_id,
      paymentId, payment.request_id, Number(part.amount_cents), group);
    if (chargeId !== part.stripe_charge_id) throw new Error("Split funding charge mismatch");
  }
}
