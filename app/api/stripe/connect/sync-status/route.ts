import Stripe from "stripe";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST() {
  try {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return NextResponse.json(
        { error: "Stripe is not configured" },
        { status: 500 }
      );
    }

    const supabase = await createClient();

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const { data: provider, error: providerError } = await supabase
      .from("provider_profiles")
      .select("stripe_account_id")
      .eq("user_id", user.id)
      .single();

    if (providerError || !provider?.stripe_account_id) {
      return NextResponse.json(
        { error: "Stripe connected account not found" },
        { status: 404 }
      );
    }

    const stripe = new Stripe(stripeSecretKey);

    const account = await stripe.v2.core.accounts.retrieve(
      provider.stripe_account_id,
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

    const { error: updateError } = await admin
      .from("provider_profiles")
      .update({
        stripe_onboarding_complete: onboardingComplete,
        stripe_payouts_enabled: payoutsEnabled,
        stripe_charges_enabled: transfersEnabled,
      })
      .eq("user_id", user.id)
      .eq("stripe_account_id", account.id);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({
      ok: true,
      onboardingComplete,
      payoutsEnabled,
      transfersEnabled,
    });
  } catch (error) {
    console.error("Stripe account status sync failed:", error);

    return NextResponse.json(
      { error: "Unable to synchronize Stripe account status" },
      { status: 500 }
    );
  }
}
