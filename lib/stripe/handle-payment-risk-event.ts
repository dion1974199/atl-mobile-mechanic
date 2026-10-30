import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";

type PaymentRiskEvent =
  | Stripe.ChargeDisputeCreatedEvent
  | Stripe.ChargeDisputeUpdatedEvent
  | Stripe.ChargeDisputeClosedEvent
  | Stripe.RefundCreatedEvent
  | Stripe.RefundUpdatedEvent
  | Stripe.RefundFailedEvent;

// A verified platform event is required. Dependencies are injectable for offline tests.
export async function handlePaymentRiskEvent(
  event: PaymentRiskEvent,
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY!),
  admin = createAdminClient()
): Promise<void> {
  if (event.account) {
    throw new Error("Connected-account risk events cannot match platform payments");
  }
  const object = event.data.object;
  const idOf = (value: string | { id: string } | null) =>
    typeof value === "string" ? value : value?.id;
  const chargeId = idOf(object.charge);
  if (!chargeId) throw new Error("Risk event missing Stripe charge ID");

  // Follow the actual charge rather than latest_charge: older charge activity
  // must also place a hold. Never trust metadata alone to select a payment.
  const charge = await stripe.charges.retrieve(chargeId);
  const paymentIntentId = idOf(charge.payment_intent);
  const eventIntentId = idOf(object.payment_intent);
  if (!paymentIntentId || (eventIntentId && eventIntentId !== paymentIntentId) ||
      charge.id !== chargeId || charge.livemode !== event.livemode) {
    throw new Error("Risk event charge/PaymentIntent mismatch");
  }

  const { data: singles, error: singleError } = await admin
    .from("service_payments").select("id, stripe_charge_id")
    .eq("stripe_payment_intent_id", paymentIntentId);
  if (singleError) throw singleError;
  const { data: parts, error: partError } = await admin
    .from("service_payment_parts").select("id, service_payment_id, stripe_charge_id")
    .eq("stripe_payment_intent_id", paymentIntentId);
  if (partError) throw partError;
  if ((singles?.length ?? 0) + (parts?.length ?? 0) !== 1) {
    throw new Error("Risk event payment match missing or ambiguous");
  }
  const match = singles?.[0] ?? parts![0];
  if (match.stripe_charge_id != null && match.stripe_charge_id !== chargeId) {
    throw new Error("Risk event Stripe charge does not match payment");
  }
  const paymentId = singles?.[0]?.id ?? parts![0].service_payment_id;
  const isDispute = event.type.startsWith("charge.dispute.");
  // Retrieve current status; delivery order is not guaranteed.
  const current = isDispute
    ? await stripe.disputes.retrieve(object.id)
    : await stripe.refunds.retrieve(object.id);
  if (current.id !== object.id || idOf(current.charge) !== chargeId ||
      (idOf(current.payment_intent) && idOf(current.payment_intent) !== paymentIntentId)) {
    throw new Error("Risk object does not match charge");
  }
  const { data: recorded, error } = await admin.rpc("record_verified_payment_payout_hold", {
    p_payment_id: paymentId,
    p_payment_intent_id: paymentIntentId,
    p_charge_id: chargeId,
    p_reason: isDispute ? "dispute" : "refund",
    p_stripe_reference: current.id,
    p_stripe_status: current.status,
  });
  if (error || recorded !== true) {
    throw new Error(`Unable to record payout hold: ${error?.message ?? "Not recorded"}`);
  }
}
