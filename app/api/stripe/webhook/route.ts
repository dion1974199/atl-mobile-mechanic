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

  let event;

  try {
    event = stripe.parseEventNotification(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (error) {
    console.error("Stripe webhook verification failed:", error);

    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 }
    );
  }

  console.log(`STRIPE_EVENT_TYPE=${event.type}`);

  try {
    if (event.type === "v2.core.account.closed") {
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
