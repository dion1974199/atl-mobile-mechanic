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
        .select("id, customer_id, provider_id, status")
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
      .select("id, stripe_payment_intent_id, payment_status")
      .eq("request_id", requestId)
      .maybeSingle();

    if (paymentError) {
      return NextResponse.json(
        { error: "Unable to load payment record" },
        { status: 500 }
      );
    }

    if (payment?.payment_status === "paid") {
      return NextResponse.json(
        { error: "This service request has already been paid" },
        { status: 409 }
      );
    }

    const stripe = new Stripe(stripeSecretKey);

    if (payment?.stripe_payment_intent_id) {
      const existingIntent = await stripe.paymentIntents.retrieve(
        payment.stripe_payment_intent_id
      );

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
        idempotencyKey: `service-payment-${paymentId}`,
      }
    );

    const { error: updateError } = await admin
      .from("service_payments")
      .update({
        stripe_payment_intent_id: paymentIntent.id,
        stripe_transfer_group: transferGroup,
        payment_status: "pending",
      })
      .eq("id", paymentId);

    if (updateError) {
      return NextResponse.json(
        { error: "Payment created but database update failed" },
        { status: 500 }
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
