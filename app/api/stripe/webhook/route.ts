import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleSplitPaymentSucceeded } from "@/lib/stripe/handle-split-payment";
import { handleSplitPaymentFailure } from "@/lib/stripe/handle-split-payment-failure";
import { handlePaymentRiskEvent } from "@/lib/stripe/handle-payment-risk-event";
import { verifySinglePayment } from "@/lib/stripe/verify-single-payment";
import { createSingleTransfer } from "@/lib/stripe/create-single-transfer";
import { reconcileSingleTransfer } from "@/lib/stripe/reconcile-single-transfer";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const ACCOUNT_SYNC_EVENTS = new Set([
  "v2.core.account.created",
  "v2.core.account.updated",
  "v2.core.account[configuration.recipient].capability_status_updated",
  "v2.core.account[configuration.recipient].updated",
  "v2.core.account[requirements].updated",
  "v2.core.account[future_requirements].updated",
  "v2.core.account[identity].updated",
]);

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing Stripe signature" },
      { status: 400 }
    );
  }

  let event: Stripe.V2.Core.EventNotification | null = null;
let standardEvent: Stripe.Event | null = null;
  try {
    try {
      event = stripe.parseEventNotification(
        body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch {
      standardEvent = stripe.webhooks.constructEvent(
        body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    }
  } catch (error) {
    console.error("Stripe webhook verification failed:", error);

    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 }
    );
  }
if (!standardEvent && !event) {
  return NextResponse.json({ received: true });
}
  if (
    standardEvent?.type === "charge.dispute.created" ||
    standardEvent?.type === "charge.dispute.updated" ||
    standardEvent?.type === "charge.dispute.closed" ||
    standardEvent?.type === "refund.created" ||
    standardEvent?.type === "refund.updated" ||
    standardEvent?.type === "refund.failed"
  ) {
    try {
      await handlePaymentRiskEvent(standardEvent);
      return NextResponse.json({ received: true });
    } catch (error) {
      console.error("Stripe payment risk processing failed:", error);
      return NextResponse.json({ error: "Payment risk processing failed" }, { status: 500 });
    }
  }

  if (
    standardEvent?.type === "payment_intent.payment_failed" ||
    standardEvent?.type === "payment_intent.canceled"
  ) {
    try {
      const paymentIntent = standardEvent.data.object as Stripe.PaymentIntent;
      await handleSplitPaymentFailure(paymentIntent);
      return NextResponse.json({ received: true });
    } catch (error) {
      console.error("Split-payment failure webhook processing failed:", error);
      return NextResponse.json(
        { error: "Split-payment failure processing failed" },
        { status: 500 }
      );
    }
  }

  if (standardEvent?.type === "payment_intent.succeeded") {
    try {
    const paymentIntent = standardEvent.data.object as Stripe.PaymentIntent;

    if (await handleSplitPaymentSucceeded(paymentIntent)) {
      return NextResponse.json({ received: true });
    }

    const paymentId = paymentIntent.metadata.service_payment_id;
    const providerStripeAccountId =
      paymentIntent.metadata.provider_stripe_account_id;
    const providerAmount = Number(paymentIntent.metadata.provider_amount);

    if (!paymentId || !providerStripeAccountId || providerAmount <= 0) {
      throw new Error("Missing payment transfer metadata");
    }

    const admin = createAdminClient();

    const { data: payment, error: paymentError } = await admin
      .from("service_payments")
      .select("id, request_id, provider_id, stripe_payment_intent_id, authorized_amount, provider_amount, currency, payment_status, stripe_transfer_id, stripe_charge_id, stripe_transfer_group, transfer_status, single_transfer_attempted_at, split_transfer_attempted_at")
      .eq("id", paymentId)
      .single();

    if (paymentError || !payment) {
      throw paymentError ?? new Error("Service payment not found");
    }

    if (payment.stripe_payment_intent_id !== paymentIntent.id) {
      throw new Error("PaymentIntent does not match the service payment");
    }

    if (
      !["pending", "paid", "partially_refunded", "refunded"].includes(
        payment.payment_status
      ) ||
      payment.split_transfer_attempted_at != null
    ) {
      throw new Error(
        "Single-card payment is not eligible for verified charge processing"
      );
    }

    const expectedTotal = Math.round(Number(payment.authorized_amount) * 100);
    const expectedProviderAmount = Math.round(Number(payment.provider_amount) * 100);

    if (
      !Number.isSafeInteger(expectedTotal) ||
      !Number.isSafeInteger(expectedProviderAmount) ||
      expectedTotal <= 0 ||
      expectedProviderAmount <= 0 ||
      payment.currency !== "usd" ||
      paymentIntent.currency !== payment.currency ||
      paymentIntent.amount_received !== expectedTotal ||
      providerAmount !== expectedProviderAmount
    ) {
      throw new Error("Stripe payment amount or currency does not match the service payment");
    }

    const { data: provider, error: providerError } = await admin
      .from("provider_profiles")
      .select("stripe_account_id")
      .eq("user_id", payment.provider_id)
      .single();

    if (providerError || !provider) {
      throw providerError ?? new Error("Payment provider profile not found");
    }

    if (
      !provider.stripe_account_id ||
      provider.stripe_account_id !== providerStripeAccountId
    ) {
      throw new Error("Provider Stripe account does not match the service payment");
    }

    const { data: serviceRequest, error: requestError } = await admin
      .from("service_requests")
      .select("status, customer_confirmed_at")
      .eq("id", payment.request_id)
      .single();

    if (
      requestError ||
      !serviceRequest ||
      !["work_completed", "completed"].includes(serviceRequest.status) ||
      !serviceRequest.customer_confirmed_at ||
      paymentIntent.metadata.service_request_id !== payment.request_id
    ) {
      throw new Error(
        "Job completion and customer satisfaction confirmation are required before transfer"
      );
    }

    const transferGroup = `service_request_${payment.request_id}`;

    if (payment.stripe_transfer_group !== transferGroup) {
      throw new Error("Single-card transfer group does not match");
    }

    const verifiedChargeId = await verifySinglePayment(
      stripe,
      paymentIntent.id,
      paymentId,
      payment.request_id,
      expectedTotal,
      transferGroup
    );

    // Never reactivate a refunded payment or initiate another payout.
    // Reconcile only a transfer that was previously attempted or recorded.
    if (["refunded", "partially_refunded"].includes(payment.payment_status)) {
      if (payment.stripe_charge_id !== verifiedChargeId) {
        throw new Error("Refunded single-card payment charge mismatch");
      }

      if (
        payment.single_transfer_attempted_at == null &&
        payment.stripe_transfer_id == null
      ) {
        if (payment.transfer_status === "processing") {
          throw new Error(
            "Refunded single-card payment has an unattempted processing claim requiring review"
          );
        }
        return NextResponse.json({ received: true });
      }

      const reconciled = await reconcileSingleTransfer(
        stripe,
        paymentId,
        payment.request_id,
        providerStripeAccountId,
        expectedProviderAmount,
        transferGroup,
        verifiedChargeId
      );

      if (!reconciled) {
        throw new Error("Refunded single-card transfer requires reconciliation");
      }

      return NextResponse.json({ received: true });
    }

    // Record the verified customer charge before considering mechanic payout.
    const { data: recorded, error: settlementError } = await admin.rpc(
      "record_verified_single_payment",
      {
        p_payment_id: paymentId,
        p_payment_intent_id: paymentIntent.id,
        p_charge_id: verifiedChargeId,
      }
    );

    if (settlementError || recorded !== true) {
      throw new Error(
        `Unable to record verified single-card payment: ${settlementError?.message ?? "settlement not confirmed"}`
      );
    }

    const { data: newlyClaimed, error: claimError } = await admin.rpc(
      "claim_single_payment_transfer",
      { p_payment_id: paymentId }
    );

    if (claimError) {
      throw new Error(`Unable to claim single-card transfer: ${claimError.message}`);
    }

    if (newlyClaimed === true) {
      await createSingleTransfer(
        stripe,
        paymentId,
        payment.request_id,
        providerStripeAccountId,
        expectedProviderAmount,
        transferGroup,
        true
      );
    }

    if (newlyClaimed !== true) {
      const { data: current, error: statusError } = await admin
        .from("service_payments")
        .select("payment_status, transfer_status, stripe_charge_id, stripe_transfer_id, single_transfer_attempted_at, payout_hold_reason, stripe_refund_id, stripe_dispute_id")
        .eq("id", paymentId)
        .single();

      if (statusError || !current) {
        throw new Error("Unable to verify current single-card payout state");
      }

      if (current.stripe_charge_id !== verifiedChargeId) {
        throw new Error("Single-card charge changed during payout processing");
      }

      if (current.transfer_status !== "processing" &&
          current.transfer_status !== "transferred") {
        // Customer payment is recorded; no mechanic transfer was authorized.
        return NextResponse.json({ received: true });
      }

      if (
        current.transfer_status === "processing" &&
        (current.payment_status !== "paid" ||
          current.payout_hold_reason != null ||
          current.stripe_refund_id != null ||
          current.stripe_dispute_id != null)
      ) {
        // Never initiate another transfer after a refund or dispute.
        // Only previously attempted transfers may reach reconciliation.
        if (
          current.single_transfer_attempted_at == null &&
          current.stripe_transfer_id == null
        ) {
          return NextResponse.json({ received: true });
        }
      }
    }

    const reconciled = await reconcileSingleTransfer(
      stripe,
      paymentId,
      payment.request_id,
      providerStripeAccountId,
      expectedProviderAmount,
      transferGroup,
      verifiedChargeId
    );

    if (!reconciled) {
      throw new Error("Single-card transfer is awaiting reconciliation");
    }

    return NextResponse.json({ received: true });
    } catch (error) {
      console.error("Stripe payment webhook processing failed:", error);
      return NextResponse.json(
        { error: "Stripe payment webhook processing failed" },
        { status: 500 }
      );
    }
  }
  try {
    if (event && event.type === "v2.core.account.closed")  {
      const admin = createAdminClient();

      const { error } = await admin
        .from("provider_profiles")
        .update({
          stripe_onboarding_complete: false,
          stripe_payouts_enabled: false,
          stripe_charges_enabled: false,
        })
        .eq("stripe_account_id", event.related_object.id);

      if (error) {
        throw error;
      }

      return NextResponse.json({ received: true });
    }

    if (!event) {
      return NextResponse.json({ received: true });
    }

    if (!ACCOUNT_SYNC_EVENTS.has(event.type)) {
      return NextResponse.json({ received: true });
    }

    if (!("related_object" in event) || !event.related_object) {
      throw new Error(`Missing related Stripe account for ${event.type}`);
    }

    if (event.related_object.type !== "v2.core.account") {
      return NextResponse.json({ received: true });
    }

    const account = await stripe.v2.core.accounts.retrieve(
      event.related_object.id,
      {
        include: ["configuration.recipient", "requirements"],
      }
    );

    const recipient = account.configuration?.recipient;
    const stripeBalance = recipient?.capabilities?.stripe_balance;

    const payoutsEnabled =
      account.closed !== true &&
      recipient?.applied === true &&
      stripeBalance?.payouts?.status === "active";

    const transfersEnabled =
      account.closed !== true &&
      recipient?.applied === true &&
      stripeBalance?.stripe_transfers?.status === "active";

    const hasBlockingUserRequirements =
      account.requirements?.entries?.some(
        (requirement) =>
          requirement.awaiting_action_from === "user" &&
          (requirement.minimum_deadline.status === "currently_due" ||
            requirement.minimum_deadline.status === "past_due")
      ) ?? false;

    const onboardingComplete =
      payoutsEnabled && transfersEnabled && !hasBlockingUserRequirements;

    const admin = createAdminClient();

    const { error } = await admin
      .from("provider_profiles")
      .update({
        stripe_onboarding_complete: onboardingComplete,
        stripe_payouts_enabled: payoutsEnabled,
        stripe_charges_enabled: transfersEnabled,
      })
      .eq("stripe_account_id", account.id);

    if (error) {
      throw error;
    }

    console.log(
      `STRIPE_ACCOUNT_SYNCED=${account.id} onboarding=${onboardingComplete} payouts=${payoutsEnabled} transfers=${transfersEnabled}`
    );

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed:", error);

    return NextResponse.json(
      { error: "Stripe webhook processing failed" },
      { status: 500 }
    );
  }
}
