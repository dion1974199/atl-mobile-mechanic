import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/require-platform-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { refundSplitPaymentPart } from "@/lib/stripe/refund-split-payment";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const administratorId = await requirePlatformAdmin();

  if (!administratorId) {
    return NextResponse.json(
      { error: "Administrator authorization required" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const partId = body?.partId;
  const reason = body?.reason;

  if (
    typeof partId !== "string" ||
    !UUID_PATTERN.test(partId) ||
    typeof reason !== "string" ||
    reason.trim().length < 10 ||
    reason.length > 2000
  ) {
    return NextResponse.json(
      { error: "Valid payment-part ID and refund reason required" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: audit, error: auditError } = await admin
    .from("payment_refund_audit")
    .insert({
      payment_part_id: partId,
      administrator_id: administratorId,
      reason: reason.trim(),
      status: "requested",
    })
    .select("id")
    .single();

  if (auditError || !audit) {
    console.error("Refund audit creation failed:", auditError);
    return NextResponse.json(
      { error: "Unable to record refund authorization" },
      { status: 500 }
    );
  }

  const { error: processingError } = await admin
    .from("payment_refund_audit")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", audit.id);

  if (processingError) {
    console.error("Refund audit processing update failed:", processingError);
    return NextResponse.json(
      { error: "Unable to begin audited refund processing" },
      { status: 500 }
    );
  }

  try {
    await refundSplitPaymentPart(partId);

    const { error: completionError } = await admin
      .from("payment_refund_audit")
      .update({ status: "succeeded", updated_at: new Date().toISOString() })
      .eq("id", audit.id);

    if (completionError) {
      throw new Error("Refund completed but audit finalization failed");
    }

    return NextResponse.json({
      success: true,
      auditId: audit.id,
    });
  } catch (error) {
    console.error("Administrator refund requires reconciliation:", error);

    const { error: reviewError } = await admin
      .from("payment_refund_audit")
      .update({
        status: "manual_review",
        error_message:
          error instanceof Error ? error.message.slice(0, 1000) : "Unknown error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", audit.id);

    if (reviewError) {
      console.error("Refund audit reconciliation flag failed:", reviewError);
    }

    return NextResponse.json(
      {
        error: "Refund outcome requires administrator reconciliation",
        auditId: audit.id,
      },
      { status: 500 }
    );
  }
}
