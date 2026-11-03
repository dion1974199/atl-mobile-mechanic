import Stripe from "stripe";
import { createSplitTransfer } from "./create-split-transfer";
import { createAdminClient } from "@/lib/supabase/admin";
import { findSplitTransfer, verifySplitTransfer } from "@/lib/stripe/find-split-transfer";
import { reconcileSplitTransfer } from "@/lib/stripe/reconcile-split-transfer";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function handleSplitPaymentSucceeded(
  paymentIntent: Stripe.PaymentIntent
): Promise<boolean> {
  const partId = paymentIntent.metadata.service_payment_part_id;

  if (!partId) {
    return false;
  }

  const admin = createAdminClient();

  const { data: part, error: partError } = await admin
    .from("service_payment_parts")
    .select(
      "id, service_payment_id, card_number, amount_cents, currency, stripe_payment_intent_id, payment_status"
    )
    .eq("id", partId)
    .single();

  if (partError || !part) {
    throw new Error("Split-payment part not found");
  }

  if (
    part.stripe_payment_intent_id !== paymentIntent.id ||
    paymentIntent.status !== "succeeded" ||
    paymentIntent.currency !== "usd" ||
    part.currency !== "usd" ||
    paymentIntent.amount_received !== Number(part.amount_cents) ||
    paymentIntent.metadata.service_payment_id !== part.service_payment_id ||
    ![1, 2].includes(part.card_number)
  ) {
    throw new Error("Split-payment Stripe verification failed");
  }

  const { data: payment, error: paymentError } = await admin
    .from("service_payments")
    .select("id, request_id, provider_id, payment_status, currency, authorized_amount, provider_amount, marketplace_fee_amount, marketplace_fee_percent")
    .eq("id", part.service_payment_id)
    .single();

  if (
    paymentError ||
    !payment ||
    payment.currency !== "usd" ||
    !["pending", "paid", "partially_refunded", "refunded"].includes(payment.payment_status) ||
    paymentIntent.metadata.service_request_id !== payment.request_id ||
    paymentIntent.metadata.provider_user_id !== payment.provider_id
  ) {
    throw new Error("Split-payment parent verification failed");
  }

  const totalCents = Math.round(Number(payment.authorized_amount) * 100);
  const feeCents = Math.round(Number(payment.marketplace_fee_amount) * 100);
  const providerCents = Math.round(Number(payment.provider_amount) * 100);

  if (
    !Number.isSafeInteger(totalCents) ||
    !Number.isSafeInteger(feeCents) ||
    !Number.isSafeInteger(providerCents) ||
    totalCents <= 0 ||
    feeCents !== Math.round(totalCents * 0.15) ||
    providerCents !== totalCents - feeCents ||
    Number(payment.marketplace_fee_percent) !== 15
  ) {
    throw new Error("Invalid split-payment settlement allocation");
  }

  const { data: provider, error: providerError } = await admin
    .from("provider_profiles")
    .select("stripe_account_id")
    .eq("user_id", payment.provider_id)
    .single();

  if (
    providerError ||
    !provider?.stripe_account_id ||
    paymentIntent.metadata.provider_stripe_account_id !==
      provider.stripe_account_id
  ) {
    throw new Error("Split-payment provider verification failed");
  }

  if (
    !provider.stripe_account_id.startsWith("acct_") ||
    provider.stripe_account_id.length <= 5
  ) {
    throw new Error("Invalid mechanic Stripe account ID");
  }

  const transferGroup = `service_request_${payment.request_id}`;
  const splitTransferKey = `split-provider-transfer-${payment.id}-v1`;

  if (paymentIntent.transfer_group !== transferGroup) {
    throw new Error("Split-payment transfer group verification failed");
  }

  const chargeId =
    typeof paymentIntent.latest_charge === "string"
      ? paymentIntent.latest_charge
      : paymentIntent.latest_charge?.id ?? null;

  if (!chargeId) {
    throw new Error("Successful split payment has no Stripe charge");
  }

  const { error: recordError } = await admin.rpc(
    "record_split_payment_success",
    {
      part_id_input: part.id,
      payment_intent_id_input: paymentIntent.id,
      charge_id_input: chargeId,
    }
  );

  if (recordError) {
    throw new Error("Unable to record successful split-card payment");
  }

  // Record customer payment independently of mechanic transfer.
  // This RPC completes the job only when both verified card charges qualify.
  const { data: ready, error: settlementError } = await admin.rpc(
    "record_verified_split_payment",
    {
      p_payment_id: part.service_payment_id,
    }
  );

  if (settlementError) {
    throw new Error("Unable to settle verified split-card payment");
  }

  if (ready !== true) {
    // One or both card charges are not yet eligible for settlement.
    // Never initiate a mechanic transfer for an unsettled payment.
    return true;
  }

  if (ready) {
    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_split_payment_transfer",
      {
        payment_id_input: part.service_payment_id,
      }
    );

    if (claimError) {
      throw new Error("Unable to reserve mechanic transfer");
    }

    if (claimed) {
      const reconciled = await reconcileSplitTransfer(
        stripe,
        payment.id,
        payment.request_id,
        provider.stripe_account_id,
        providerCents,
        transferGroup
      );

      if (reconciled) {
        console.log(`SPLIT_TRANSFER_RECONCILED=${payment.id}`);
      } else {
        const transfer = await createSplitTransfer(
          stripe,
          payment.id,
          payment.request_id,
          provider.stripe_account_id,
          providerCents,
          transferGroup,
          claimed === true
        );

        const { error: completionError } = await admin.rpc(
          "complete_split_payment_transfer",
          {
            payment_id_input: payment.id,
            transfer_id_input: transfer.id,
          }
        );

        if (completionError) {
          throw new Error(
            `Stripe transfer ${transfer.id} created but database settlement failed`
          );
        }

        console.log(`SPLIT_TRANSFER_COMPLETED=${payment.id}`);
      }
    } else {
      const { data: settlement, error: settlementError } = await admin
        .from("service_payments")
        .select("transfer_status")
        .eq("id", payment.id)
        .single();

      if (settlementError || !settlement) {
        throw new Error("Unable to check split-payment settlement status");
      }

      if (["processing", "transferred"].includes(settlement.transfer_status)) {
        await reconcileSplitTransfer(
          stripe,
          payment.id,
          payment.request_id,
          provider.stripe_account_id,
          providerCents,
          transferGroup
        );
      }
    }
  }

  // No transfer occurs here. Settlement safeguards are still required.
  return true;
}
