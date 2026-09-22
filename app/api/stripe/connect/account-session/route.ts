import Stripe from "stripe";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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

    const accountSession = await stripe.accountSessions.create({
      account: provider.stripe_account_id,
      components: {
        account_onboarding: {
          enabled: true,
        },
      },
    });

    return NextResponse.json({
      clientSecret: accountSession.client_secret,
    });
  } catch (error) {
    console.error("Stripe Account Session creation failed:", error);

    return NextResponse.json(
      { error: "Unable to create Stripe Account Session" },
      { status: 500 }
    );
  }
}