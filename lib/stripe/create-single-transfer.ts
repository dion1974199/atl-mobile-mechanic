import { verifyTransferFunding } from "./verify-transfer-funding";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  findSingleTransfer,
  verifySingleTransfer,
} from "@/lib/stripe/find-single-transfer";

export async function createSingleTransfer(
  stripe: Stripe,
  paymentId: string,
  requestId: string,
  providerAccountId: string,
  providerAmountCents: number,
  transferGroup: string,
  newlyClaimed: boolean
): Promise<Stripe.Transfer> {
  if (newlyClaimed !== true) {
    throw new Error("Single-card transfer requires a newly claimed payment");
  }

  if (!Number.isSafeInteger(providerAmountCents) || providerAmountCents <= 0) {
    throw new Error("Invalid mechanic transfer amount");
  }

  const admin = createAdminClient();

  const { data: payment, error: paymentError } = await admin
    .from("service_payments")
    .select(
      "payment_status, transfer_status, stripe_transfer_id, single_transfer_attempted_at, payout_hold_reason"
    )
    .eq("id", paymentId)
    .single();

  if (
    paymentError ||
    !payment ||
    payment.payout_hold_reason != null ||
    payment.payment_status !== "pending" ||
    payment.transfer_status !== "processing" ||
    payment.stripe_transfer_id ||
    payment.single_transfer_attempted_at
  ) {
    throw new Error("Single-card payment is not eligible for transfer");
  }

  const existingTransfer = await findSingleTransfer(stripe, paymentId);

  if (existingTransfer) {
    verifySingleTransfer(
      existingTransfer,
      paymentId,
      requestId,
      providerAccountId,
      providerAmountCents,
      transferGroup
    );

    throw new Error(
      "Existing Stripe transfer requires reconciliation before completion"
    );
  }

  await verifyTransferFunding(stripe, paymentId);

  const { data: attemptStarted, error: attemptError } = await admin.rpc(
    "begin_single_transfer_attempt",
    { p_payment_id: paymentId }
  );

  if (attemptError || attemptStarted !== true) {
    throw new Error("Single-card transfer attempt could not be authorized");
  }

  const transfer = await stripe.transfers.create(
    {
      amount: providerAmountCents,
      currency: "usd",
      destination: providerAccountId,
      transfer_group: transferGroup,
      metadata: {
        service_payment_id: paymentId,
        service_request_id: requestId,
        payment_mode: "single",
      },
    },
    {
      idempotencyKey: `single-provider-transfer-${paymentId}-v1`,
      maxNetworkRetries: 0,
    }
  );

  verifySingleTransfer(
    transfer,
    paymentId,
    requestId,
    providerAccountId,
    providerAmountCents,
    transferGroup
  );

  return transfer;
}
