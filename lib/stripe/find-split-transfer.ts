import Stripe from "stripe";

export async function findSplitTransfer(
  stripe: Stripe,
  paymentId: string
): Promise<Stripe.Transfer | null> {
  const matches: Stripe.Transfer[] = [];

  for await (const transfer of stripe.transfers.list({ limit: 100 })) {
    if (
      transfer.metadata?.service_payment_id === paymentId
    ) {
      matches.push(transfer);
    }
  }

  if (matches.length > 1) {
    throw new Error("Multiple transfers found for service payment");
  }

  return matches[0] ?? null;
}

export function verifySplitTransfer(
  transfer: Stripe.Transfer,
  paymentId: string,
  requestId: string,
  providerAccountId: string,
  expectedAmountCents: number,
  expectedTransferGroup: string
): void {
  if (
    !Number.isSafeInteger(expectedAmountCents) ||
    expectedAmountCents <= 0 ||
    transfer.amount !== expectedAmountCents ||
    transfer.currency !== "usd" ||
    transfer.destination !== providerAccountId ||
    transfer.transfer_group !== expectedTransferGroup ||
    transfer.metadata?.service_payment_id !== paymentId ||
    transfer.metadata?.service_request_id !== requestId ||
    transfer.metadata?.payment_mode !== "split" ||
    transfer.reversed ||
    transfer.amount_reversed !== 0
  ) {
    throw new Error("Existing Stripe split transfer failed verification");
  }
}
