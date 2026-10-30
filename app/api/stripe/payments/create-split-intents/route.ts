import Stripe from "stripe";
import { findSplitPaymentIntent } from "@/lib/stripe/find-split-payment-intent";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
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
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => null);
    const requestId = body?.requestId;
    const firstCardCents = body?.firstCardCents;

    if (
      typeof requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ||
      !Number.isSafeInteger(firstCardCents) ||
      firstCardCents < 50
    ) {
      return NextResponse.json(
        { error: "Valid request ID and first-card amount are required" },
        { status: 400 }
      );
    }

    const admin = createAdminClient();

    const { data: serviceRequest, error: requestError } = await admin
      .from("service_requests")
      .select("id, customer_id, provider_id, status, customer_confirmed_at")
      .eq("id", requestId)
      .single();

    if (requestError || !serviceRequest) {
      return NextResponse.json(
        { error: "Service request not found" },
        { status: 404 }
      );
    }

    if (serviceRequest.customer_id !== user.id) {
      return NextResponse.json(
        { error: "Only the customer can pay for this request" },
        { status: 403 }
      );
    }

    if (
      serviceRequest.status !== "work_completed" ||
      !serviceRequest.customer_confirmed_at ||
      !serviceRequest.provider_id
    ) {
      return NextResponse.json(
        { error: "Finished, customer-confirmed service is required" },
        { status: 403 }
      );
    }

    const { data: provider, error: providerError } = await admin
      .from("provider_profiles")
      .select("stripe_account_id, stripe_payouts_enabled")
      .eq("user_id", serviceRequest.provider_id)
      .single();

    if (
      providerError ||
      !provider?.stripe_account_id ||
      provider.stripe_payouts_enabled !== true
    ) {
      return NextResponse.json(
        { error: "Provider is not ready to receive payments" },
        { status: 409 }
      );
    }

    const { data: payment, error: paymentError } = await admin
      .from("service_payments")
      .select("id, payment_status, stripe_payment_intent_id")
      .eq("request_id", requestId)
      .maybeSingle();

    if (paymentError || !payment) {
      return NextResponse.json(
        { error: "Payment record is unavailable" },
        { status: 409 }
      );
    }

    if (
      payment.payment_status !== "pending" ||
      payment.stripe_payment_intent_id
    ) {
      return NextResponse.json(
        { error: "Payment is not eligible for split checkout" },
        { status: 409 }
      );
    }

    const { data: parts, error: splitError } = await admin.rpc(
      "initialize_split_payment",
      {
        payment_id_input: payment.id,
        first_card_cents: firstCardCents,
      }
    );

    if (splitError || !Array.isArray(parts) || parts.length !== 2) {
      return NextResponse.json(
        { error: splitError?.message ?? "Unable to initialize split payment" },
        { status: 409 }
      );
    }

    const stripe = new Stripe(stripeSecretKey);
    const transferGroup = `service_request_${requestId}`;
    const results = [];

    for (const part of parts) {
      const amount = Number(part.amount_cents);

      if (
        ![1, 2].includes(part.card_number) ||
        !Number.isSafeInteger(amount) ||
        amount < 50
      ) {
        throw new Error("Invalid split-payment allocation");
      }

      const { data: savedPart, error: savedPartError } = await admin
        .from("service_payment_parts")
        .select("stripe_payment_intent_id")
        .eq("id", part.payment_part_id)
        .single();

      if (savedPartError || !savedPart) {
        throw new Error("Unable to load split-payment card record");
      }

      const recoveredIntent = savedPart.stripe_payment_intent_id
        ? null
        : await findSplitPaymentIntent(stripe, part.payment_part_id);

      if (!savedPart.stripe_payment_intent_id) {
        const { data: reserved, error: reservationError } = await admin.rpc(
          "reserve_split_payment_intent_creation",
          { part_id_input: part.payment_part_id }
        );

        if (reservationError) {
          throw new Error(
            "Unable to verify split-card creation reservation"
          );
        }

        if (reserved === true && recoveredIntent) {
          throw new Error(
            "Stripe PaymentIntent exists without a prior reservation; manual reconciliation required"
          );
        }

        if (reserved !== true && !recoveredIntent) {
          throw new Error(
            "Existing reservation requires Stripe reconciliation before checkout"
          );
        }
      }

      const intent: Stripe.PaymentIntent = savedPart.stripe_payment_intent_id
        ? await stripe.paymentIntents.retrieve(
            savedPart.stripe_payment_intent_id
          )
        : recoveredIntent ?? await stripe.paymentIntents.create(
        {
          amount,
          currency: "usd",
          payment_method_types: ["card"],
          transfer_group: transferGroup,
          metadata: {
            service_request_id: requestId,
            service_payment_id: payment.id,
            service_payment_part_id: part.payment_part_id,
            provider_user_id: serviceRequest.provider_id,
            provider_stripe_account_id: provider.stripe_account_id,
            card_number: String(part.card_number),
          },
        },
        {
          idempotencyKey: `split-payment-part-${part.payment_part_id}-v1`,
        }
      );

      if (
        intent.amount !== amount ||
        intent.currency !== "usd" ||
        intent.metadata.service_payment_part_id !== part.payment_part_id ||
        intent.metadata.service_payment_id !== payment.id ||
        intent.metadata.service_request_id !== requestId ||
        intent.metadata.provider_user_id !== serviceRequest.provider_id ||
        intent.metadata.provider_stripe_account_id !== provider.stripe_account_id ||
        intent.metadata.card_number !== String(part.card_number) ||
        intent.transfer_group !== transferGroup ||
        !["requires_payment_method", "requires_confirmation"].includes(intent.status) ||
        !intent.client_secret
      ) {
        throw new Error("Stripe split-payment verification failed");
      }

      const { error: registrationError } = await admin.rpc(
        "register_split_payment_intent",
        {
          part_id_input: part.payment_part_id,
          payment_intent_id_input: intent.id,
        }
      );

      if (registrationError) {
        throw new Error("Unable to register split-card PaymentIntent");
      }

      const { data: registeredPart, error: verifyError } = await admin
        .from("service_payment_parts")
        .select("stripe_payment_intent_id")
        .eq("id", part.payment_part_id)
        .single();

      if (
        verifyError ||
        registeredPart?.stripe_payment_intent_id !== intent.id
      ) {
        throw new Error("Split-card PaymentIntent registration mismatch");
      }

      results.push({
        cardNumber: part.card_number,
        amountCents: amount,
        clientSecret: intent.client_secret,
      });
    }

    return NextResponse.json({
      paymentId: payment.id,
      cards: results,
    });
  } catch (error) {
    console.error("Split-payment checkout creation failed:", error);

    return NextResponse.json(
      { error: "Unable to prepare two-card checkout" },
      { status: 500 }
    );
  }
}
