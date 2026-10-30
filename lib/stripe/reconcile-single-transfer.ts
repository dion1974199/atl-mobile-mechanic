import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  findSingleTransfer,
  verifySingleTransfer,
} from "@/lib/stripe/find-single-transfer";

export async function reconcileSingleTransfer(
  stripe: Stripe,
  paymentId: string,
  requestId: string,
  providerAccountId: string,
  providerAmountCents: number,
  transferGroup: string,
  chargeId: string
): Promise<boolean> {
  const admin = createAdminClient();

  const { data: payment, error: paymentError } = await admin
    .from("service_payments")
    .select(
      "payment_status, transfer_status, stripe_transfer_id, stripe_charge_id, single_transfer_attempted_at"
    )
    .eq("id", paymentId)
    .single();

  if (paymentError || !payment) {
    throw new Error("Unable to load single-card transfer status");
  }

  if (payment.transfer_status === "transferred") {
    if (
      !payment.stripe_transfer_id ||
      payment.stripe_charge_id !== chargeId ||
      payment.payment_status !== "paid"
    ) {
      throw new Error("Recorded single-card settlement is inconsistent");
    }

    const transfer = await stripe.transfers.retrieve(
      payment.stripe_transfer_id
    );

    verifySingleTransfer(
      transfer,
      paymentId,
      requestId,
      providerAccountId,
      providerAmountCents,
      transferGroup,
      true
    );

    return true;
  }

  if (
    payment.payment_status !== "pending" ||
    payment.transfer_status !== "processing"
  ) {
    throw new Error("Single-card transfer is not eligible for reconciliation");
  }

  const transfer = await findSingleTransfer(stripe, paymentId);

  if (!transfer) {
    if (payment.single_transfer_attempted_at) {
      console.error("SINGLE_TRANSFER_REQUIRES_MANUAL_REVIEW", {
        paymentId,
        attemptedAt: payment.single_transfer_attempted_at,
        reason: "Attempt recorded but no matching Stripe transfer found",
      });

      throw new Error(
        "Single-card transfer outcome uncertain; manual review required"
      );
    }

    return false;
  }

  verifySingleTransfer(
    transfer,
    paymentId,
    requestId,
    providerAccountId,
    providerAmountCents,
    transferGroup
  );

  const { data: completed, error } = await admin.rpc(
    "complete_single_payment_transfer",
    {
      p_payment_id: paymentId,
      p_transfer_id: transfer.id,
      p_charge_id: chargeId,
    }
  );

  if (error || completed !== true) {
    throw new Error(
      `Unable to reconcile single-card transfer: ${
        error?.message ?? "Completion was not confirmed"
      }`
    );
  }

  return true;
}
