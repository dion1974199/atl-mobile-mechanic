import Stripe from "stripe";
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
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const requestId = body.requestId;

    if (!requestId) {
      return NextResponse.json(
        { error: "Service request ID is required" },
        { status: 400 }
      );
    }

    const admin = createAdminClient();

    const { data: serviceRequest, error: serviceRequestError } =
      await admin
        .from("service_requests")
        .select("id, customer_id, provider_id, status, customer_confirmed_at")
        .eq("id", requestId)
        .single();

    if (serviceRequestError || !serviceRequest) {
      return NextResponse.json(
        { error: "Service request not found" },
        { status: 404 }
      );
    }

    if (serviceRequest.customer_id !== user.id) {
      return NextResponse.json(
        { error: "Only the customer can pay for this service request" },
        { status: 403 }
      );
    }

    if (
      serviceRequest.status !== "work_completed" ||
      !serviceRequest.customer_confirmed_at
    ) {
      return NextResponse.json(
        {
          error:
            "The provider must finish the work and the customer must confirm satisfaction before payment.",
        },
        { status: 403 }
      );
    }

    if (!serviceRequest.provider_id) {
      return NextResponse.json(
        { error: "Service request has no assigned provider" },
        { status: 400 }
      );
    }

    const { data: authorizations, error: authorizationError } =
      await admin
        .from("repair_authorizations")
        .select("parts_amount, labor_amount")
        .eq("request_id", requestId)
        .eq("status", "approved");

    if (authorizationError) {
      return NextResponse.json(
        { error: "Unable to calculate approved repair total" },
        { status: 500 }
      );
    }

    const approvedTotal = (authorizations ?? []).reduce(
      (total, authorization) =>
        total +
        Number(authorization.parts_amount ?? 0) +
        Number(authorization.labor_amount ?? 0),
      0
    );

    if (approvedTotal <= 0) {
      return NextResponse.json(
        { error: "No approved repair amount found" },
        { status: 400 }
      );
    }

    const amountInCents = Math.round(approvedTotal * 100);

    if (
      !Number.isSafeInteger(amountInCents) ||
      amountInCents < 50 ||
      amountInCents > 99999999
    ) {
      return NextResponse.json(
        { error: "Approved repair total is outside the supported payment range" },
        { status: 400 }
      );
    }

    const marketplaceFeeAmount = Math.round(amountInCents * 0.15);
    const providerAmount = amountInCents - marketplaceFeeAmount;

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
        { error: "Provider is not ready to receive Stripe payments" },
        { status: 400 }
      );
    }

    const { data: payment, error: paymentError } = await admin
      .from("service_payments")
      .select("id, stripe_payment_intent_id, payment_status, transfer_status, stripe_transfer_id, single_transfer_attempted_at, split_transfer_attempted_at")
      .eq("request_id", requestId)
      .maybeSingle();

    if (paymentError) {
      return NextResponse.json(
        { error: "Unable to load payment record" },
        { status: 500 }
      );
    }

    if (
      payment &&
      (
        payment.payment_status !== "pending" ||
        payment.transfer_status !== "not_transferred" ||
        payment.stripe_transfer_id != null ||
        payment.single_transfer_attempted_at != null ||
        payment.split_transfer_attempted_at != null
      )
    ) {
      return NextResponse.json(
        { error: "Payment is not eligible for checkout; settlement or review may be required" },
        { status: 409 }
      );
    }

    if (payment?.payment_status === "paid") {
      return NextResponse.json(
        { error: "This service request has already been paid" },
        { status: 409 }
      );
    }

    if (payment) {
      const { data: splitParts, error: splitPartsError } = await admin
        .from("service_payment_parts")
        .select("id")
        .eq("service_payment_id", payment.id)
        .limit(1);

      if (splitPartsError) {
        return NextResponse.json(
          { error: "Unable to verify payment mode" },
          { status: 500 }
        );
      }

      if (splitParts && splitParts.length > 0) {
        return NextResponse.json(
          { error: "Two-card checkout has already been initialized for this job" },
          { status: 409 }
        );
      }
    }

    const stripe = new Stripe(stripeSecretKey);

    if (payment?.stripe_payment_intent_id) {
      const existingIntent = await stripe.paymentIntents.retrieve(
        payment.stripe_payment_intent_id
      );

      if (
        !["requires_payment_method", "requires_confirmation"].includes(existingIntent.status) ||
        existingIntent.amount !== amountInCents ||
        existingIntent.currency !== "usd" ||
        existingIntent.metadata.service_payment_id !== payment.id ||
        existingIntent.metadata.service_request_id !== requestId ||
        existingIntent.transfer_group !== `service_request_${requestId}` ||
        !existingIntent.client_secret
      ) {
        return NextResponse.json(
          { error: "Existing Stripe payment requires review; checkout cannot resume" },
          { status: 409 }
        );
      }

      return NextResponse.json({
        clientSecret: existingIntent.client_secret,
        paymentId: payment.id,
      });
    }

    let paymentId = payment?.id;

    if (!paymentId) {
      const { data: createdPaymentId, error: createPaymentError } =
        await supabase.rpc("create_service_payment", {
          request_id_input: requestId,
        });

      if (createPaymentError || !createdPaymentId) {
        return NextResponse.json(
          {
            error:
              createPaymentError?.message ??
              "Unable to create payment record",
          },
          { status: 500 }
        );
      }

      paymentId = createdPaymentId;
    }

    const transferGroup = `service_request_${requestId}`;

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountInCents,
        currency: "usd",
        automatic_payment_methods: {
          enabled: true,
        },
        transfer_group: transferGroup,
        metadata: {
          service_request_id: requestId,
          service_payment_id: paymentId,
          provider_user_id: serviceRequest.provider_id,
          provider_stripe_account_id: provider.stripe_account_id,
          marketplace_fee_amount: marketplaceFeeAmount.toString(),
          provider_amount: providerAmount.toString(),
        },
      },
      {
        idempotencyKey: `service-payment-${paymentId}-${amountInCents}-v2`,
      }
    );

    const { data: updatedPayment, error: updateError } = await admin
      .from("service_payments")
      .update({
        stripe_payment_intent_id: paymentIntent.id,
        stripe_transfer_group: transferGroup,
        payment_status: "pending",
      })
      .eq("id", paymentId)
      .eq("payment_status", "pending")
      .eq("transfer_status", "not_transferred")
      .is("stripe_transfer_id", null)
      .is("single_transfer_attempted_at", null)
      .is("split_transfer_attempted_at", null)
      .is("stripe_payment_intent_id", null)
      .select("id")
      .maybeSingle();

    if (updateError) {
      return NextResponse.json(
        { error: "Payment created but database update failed" },
        { status: 500 }
      );
    }

    if (!updatedPayment) {
      return NextResponse.json(
        {
          error: "Payment checkout state changed; payment requires reconciliation",
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      paymentId,
    });
  } catch (error) {
    console.error("Stripe payment intent creation failed:", error);

    return NextResponse.json(
      { error: "Unable to create payment" },
      { status: 500 }
    );
  }
}
