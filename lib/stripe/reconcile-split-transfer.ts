import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  findSplitTransfer,
  verifySplitTransfer,
} from "@/lib/stripe/find-split-transfer";

export async function reconcileSplitTransfer(
  stripe: Stripe,
  paymentId: string,
  requestId: string,
  providerAccountId: string,
  providerAmountCents: number,
  transferGroup: string
): Promise<boolean> {
  const admin = createAdminClient();

  const { data: payment, error: paymentError } = await admin
    .from("service_payments")
    .select("transfer_status, stripe_transfer_id, split_transfer_attempted_at")
    .eq("id", paymentId)
    .single();

  if (paymentError || !payment) {
    throw new Error("Unable to load split-payment transfer status");
  }

  if (payment.transfer_status === "transferred") {
    if (!payment.stripe_transfer_id) {
      throw new Error("Settled payment is missing its Stripe transfer ID");
    }

    const existingTransfer = await stripe.transfers.retrieve(
      payment.stripe_transfer_id
    );

    verifySplitTransfer(
      existingTransfer,
      paymentId,
      requestId,
      providerAccountId,
      providerAmountCents,
      transferGroup
    );

    return true;
  }

  if (payment.transfer_status !== "processing") {
    throw new Error("Split-payment transfer is not reserved");
  }

  const transfer = await findSplitTransfer(stripe, paymentId);

  if (!transfer) {
    if (payment.split_transfer_attempted_at) {
      console.error("SPLIT_TRANSFER_REQUIRES_MANUAL_REVIEW", {
        paymentId,
        attemptedAt: payment.split_transfer_attempted_at,
        reason: "Transfer attempt recorded but no matching Stripe transfer found",
      });
    }

    if (payment.split_transfer_attempted_at) {
      throw new Error(
        "Split transfer attempt already recorded; reconciliation or manual review required"
      );
    }

    return false;
  }

  verifySplitTransfer(
    transfer,
    paymentId,
    requestId,
    providerAccountId,
    providerAmountCents,
    transferGroup
  );

  const { error } = await admin.rpc("complete_split_payment_transfer", {
    payment_id_input: paymentId,
    transfer_id_input: transfer.id,
  });

  if (error) {
    throw new Error(`Unable to reconcile split transfer: ${error.message}`);
  }

  return true;
}
