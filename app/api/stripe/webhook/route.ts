import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";

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
  if (standardEvent?.type === "payment_intent.succeeded") {
    const paymentIntent = standardEvent.data.object as Stripe.PaymentIntent;
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
      .select("id, stripe_transfer_id, transfer_status")
      .eq("id", paymentId)
      .single();

    if (paymentError || !payment) {
      throw paymentError ?? new Error("Service payment not found");
    }

    let transferId = payment.stripe_transfer_id;

    if (!transferId) {
      const transfer = await stripe.transfers.create(
        {
          amount: providerAmount,
          currency: "usd",
          destination: providerStripeAccountId,
          transfer_group: paymentIntent.transfer_group ?? undefined,
          metadata: {
            service_payment_id: paymentId,
            service_request_id:
              paymentIntent.metadata.service_request_id ?? "",
          },
        },
        {
          idempotencyKey: `provider-transfer-${paymentId}`,
        }
      );

      transferId = transfer.id;
    }

    const { error: updateError } = await admin
      .from("service_payments")
      .update({
        payment_status: "paid",
        stripe_charge_id:
          typeof paymentIntent.latest_charge === "string"
            ? paymentIntent.latest_charge
            : paymentIntent.latest_charge?.id ?? null,
        stripe_transfer_id: transferId,
        transfer_status: "transferred",
        paid_at: new Date().toISOString(),
        provider_transferred_at: new Date().toISOString(),
        payment_error: null,
        transfer_error: null,
      })
      .eq("id", paymentId);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({ received: true });
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
