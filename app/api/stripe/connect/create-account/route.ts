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
      .select(
        "provider_type, approval_status, background_check_status, insurance_status, insurance_expiration_date, agreement_accepted, stripe_account_id"
      )
      .eq("user_id", user.id)
      .single();

    if (providerError || !provider) {
      return NextResponse.json(
        { error: "Provider profile not found" },
        { status: 404 }
      );
    }

    const insuranceIsCurrent =
      provider.insurance_expiration_date &&
      provider.insurance_expiration_date >=
        new Date().toISOString().slice(0, 10);

    const providerIsEligible =
      provider.approval_status === "approved" &&
      provider.background_check_status === "approved" &&
      provider.insurance_status === "approved" &&
      provider.agreement_accepted === true &&
      insuranceIsCurrent;

    if (!providerIsEligible) {
      return NextResponse.json(
        { error: "Provider is not eligible for Stripe onboarding" },
        { status: 403 }
      );
    }

    if (provider.stripe_account_id) {
      return NextResponse.json({
        ok: true,
        alreadyExists: true,
      });
    }

    const stripe = new Stripe(stripeSecretKey);

    const account = await stripe.v2.core.accounts.create(
      {
        contact_email: user.email,
        dashboard: "express",
        identity: {
          country: "US",
        },
        defaults: {
          responsibilities: {
            fees_collector: "application",
            losses_collector: "application",
          },
        },
        configuration: {
          recipient: {
            capabilities: {
              stripe_balance: {
                stripe_transfers: {
                  requested: true,
                },
              },
            },
          },
        },
        metadata: {
          provider_user_id: user.id,
          provider_type: provider.provider_type,
        },
      },
      {
        idempotencyKey: `provider-connect-${user.id}`,
      }
    );

    const admin = createAdminClient();

    const { error: updateError } = await admin
      .from("provider_profiles")
      .update({
        stripe_account_id: account.id,
        stripe_onboarding_complete: false,
        stripe_payouts_enabled: false,
        stripe_charges_enabled: false,
      })
      .eq("user_id", user.id);

    if (updateError) {
      console.error(
        "Stripe account created but provider profile update failed:",
        updateError
      );

      return NextResponse.json(
        { error: "Stripe account created but database update failed" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      alreadyExists: false,
    });
  } catch (error) {
    console.error("Stripe Connect account creation failed:", error);

    return NextResponse.json(
      { error: "Unable to create Stripe connected account" },
      { status: 500 }
    );
  }
}