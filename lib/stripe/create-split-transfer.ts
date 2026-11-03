import { verifyTransferFunding } from "./verify-transfer-funding";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { findSplitTransfer, verifySplitTransfer } from "@/lib/stripe/find-split-transfer";

export async function createSplitTransfer(
  stripe: Stripe,
  paymentId: string,
  requestId: string,
  providerAccountId: string,
  providerAmountCents: number,
  transferGroup: string,
  newlyClaimed: boolean
): Promise<Stripe.Transfer> {
  if (newlyClaimed !== true) {
    throw new Error(
      "Split transfer creation requires a newly claimed settlement"
    );
  }
  if (!Number.isSafeInteger(providerAmountCents) || providerAmountCents <= 0) {
    throw new Error("Invalid mechanic transfer amount");
  }

  const admin = createAdminClient();

  const { data: payment, error: paymentError } = await admin
    .from("service_payments")
    .select("transfer_status, stripe_transfer_id, payment_status, payout_hold_reason")
    .eq("id", paymentId)
    .single();

  if (
    paymentError ||
    !payment ||
    payment.payout_hold_reason != null ||
    payment.transfer_status !== "processing" ||
    payment.stripe_transfer_id ||
    payment.payment_status !== "paid"
  ) {
    throw new Error("Split transfer is not eligible for creation");
  }

  const existingTransfer = await findSplitTransfer(stripe, paymentId);

  if (existingTransfer) {
    verifySplitTransfer(
      existingTransfer,
      paymentId,
      requestId,
      providerAccountId,
      providerAmountCents,
      transferGroup
    );
    return existingTransfer;
  }

  await verifyTransferFunding(stripe, paymentId);

  const { data: attemptStarted, error: attemptError } = await admin.rpc(
    "begin_split_transfer_attempt",
    { payment_id_input: paymentId }
  );

  if (attemptError || attemptStarted !== true) {
    throw new Error(
      "Split transfer attempt already started or could not be authorized"
    );
  }

  // Transfer creation must only be called for a newly claimed payment.
  // Never automatically retry a processing payment after an uncertain
  // Stripe response; reconcile it or require manual review instead.
  const transfer = await stripe.transfers.create(
    {
      amount: providerAmountCents,
      currency: "usd",
      destination: providerAccountId,
      transfer_group: transferGroup,
      metadata: {
        service_payment_id: paymentId,
        service_request_id: requestId,
        payment_mode: "split",
      },
    },
    {
      idempotencyKey: `split-provider-transfer-${paymentId}-v1`,
      maxNetworkRetries: 0,
    }
  );

  verifySplitTransfer(
    transfer,
    paymentId,
    requestId,
    providerAccountId,
    providerAmountCents,
    transferGroup
  );

  return transfer;
}
